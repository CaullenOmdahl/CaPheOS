# The CaPheOS backend

**Status:** design, for approval. Nothing here is implemented.
**Replaces:** the StarNetOS sidecar as CaPheOS's runtime.
**Related:** `docs/PARITY.md` (the acceptance test: parity + extensibility − bloat), `docs/FOUNDING.md` (bootstrap,
setup, launch), `docs/CONSOLE-API.md` (the frozen frontend contract), `docs/FEATURES.md` (what we are *not* rebuilding),
`docs/MODULE-SYSTEM.md` (how tools and integrations are added), `docs/PORTING.md` (house rules for ported code),
`docs/DEPLOY.md` (deployment, browser/desktop, grants and the security seat), `docs/STYLE.md` (plain language: the rule
for every name, comment and error).

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

**One process (decided).** The console server and the runtime are the same Node program: no proxy, no second port, no
second token, no `.starnet-data`. The console's existing 70 routes keep their paths; the runtime adds its own.

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
- **Runs are addressable and replayable**, and the format is not new. `console/chat-runs.js` already carries it: an
  NDJSON journal of `{c?, name, payload}` lines, one `company/state/chat-runs.json` row per run, and a final
  `console.final {text, complete}` line; hardened by `c554f79` (survives a console restart and a reload), `8a33e94`
  (a meeting re-attaches) and `a383a0c` (a refusal is journaled). The new runtime keeps those shapes and drops only the
  station cursor (`c`) and the observer feed.
- **Tool results and approvals are structured**, not scraped from text: a run step is
  `{type: text|tool|approval|usage|end, ...}` and the console renders it.
- **Failure is explicit:** a provider refusal, a budget hold, a missing tool and a timeout each end the run with a
  distinct status the console already knows how to show.

### 6.5 Desktop and browser are a plugin, not core

The design is already written: `docs/DEPLOY.md` §4 (browser and desktop) and §5 (grants). This section states only what
the backend owes it.

StarNet's mode — the owner's own headed Chrome over CDP, and Windows CUA on the owner's live desktop — is what we do
**not** keep: it hands an agent the owner's machine and their signed-in sessions. The plan keeps the *driver
abstraction* and reuses the CUA backend, and changes the target: never the owner's live session.

What the `desktop` plugin ships:

- **the driver abstraction** `{screenshot, readTree, click, type, key, drag}`, with Linux (XTEST/libei, AT-SPI) as the
  backend that runs in the deploy, and Windows CUA (x64) as an optional backend for a Windows target;

**The desktop is Linux.** The environment is a Linux microVM with a virtual display and a headed Chrome — the same Linux
the deployment already is (s6, btrfs/LUKS, read-only root), and microVMs (Firecracker, Cloud Hypervisor, Kata) take
Linux guests. Windows CUA is **not the environment and not a container**: it is a driver backend for the cases where the
target really is a Windows desktop (an x64 app under test), it is x64-only, and it is simply unused in a Linux deploy.
Containerized Windows is not on the table: Windows containers need a Windows host and licence, they double the memory
budget, and they buy nothing for browser work. If a Windows app ever has to be driven, that is a separate opt-in plugin
with a signed risk acceptance — not the default desk.
- **the environment**: a microVM with no host mounts, no Docker socket, an egress allowlist, a disposable home, PID/
  memory caps and a kill switch; no GPU passthrough without a signed risk acceptance (D13);
- **the browser**: headed real Chrome with a dedicated extension-free profile per identity, launched without
  `--enable-automation`/`--headless`; a CDP attach alone does not set `navigator.webdriver`; a headless Chromium
  sidecar server-side (D3, D12);
- **step-in**: the agent parks, the owner signs in, then it hands back;
- **the browser host**: on the owner's machine for realism; kill authority sits with it.

What the backend owes it:

- **one tool name and one gate.** The plugin owns the environment lifecycle, the driver, the profile and the
  screenshots; the core only knows "a tool call ran and returned evidence".
- **the grant gate is the tool host's.** Every browser action is admitted by
  `browserAdmit({grantId, url, action}) → allow | deny | ask` from a grant (origins, identity class, capability,
  window, rate, expiry, revocation) — never from the tool call alone (D16–D18).
- **revocation is a real kill**: three lists — live sessions, persistent profiles, service connections.
- **capabilities stay explicit**: network from inside the environment only; downloads land in the task's work folder;
  the owner can see the session.

The environment itself is not on the backend's critical path: `docs/DEPLOY.md` puts the browser sidecar in P2 and the
desktop microVM in P3.

**Persistence — three stores, deliberately separate.**

| Store | Persists? | Where | Bounds |
|---|---|---|---|
| **the identity profile** (cookies, sign-ins) | **yes, per identity** | an encrypted profile store, hydrated into the environment at boot and committed at the end | the grant: window, expiry, revocation; 30-day idle, 90-day re-consent (D16–D18) |
| **the task workspace** (downloads, screenshots, evidence) | yes, per task | `company/work/tasks/<id>/` | the retention policy |
| **the desktop itself** | **no, by default** | disposable; a pre-warmed base image makes boot cheap | a long-lived machine is an explicit grant |

The rule: **the machine is disposable; the identity is not.** Without that, step-in is useless — the owner would sign in
on every task — and the three identity classes (personal, dedicated-agent, service) have nothing to describe. The
profile store is never readable by the agent, only by the browser inside the environment; revocation deletes it; a
snapshot never contains it in the clear; and an identity is created by step-in, never imported from the owner's own
browser (D14).

`docs/DEPLOY.md` §5 already lists persistent profiles in its revocation lists; §3's "ephemeral profile" means the
disposable home of the machine, not the identity.

---

## 7. Keep, port, rewrite, drop

| Disposition | What |
|---|---|
| **Keep as-is** | the console UI and its 70 routes; the company tools; the dispatcher; approvals; budgets; governance; meetings; commitments; intake; ledger; core modules; skills |
| **Vendor with attribution** | StarNet's provider adapters (`anthropic`, `openai-compatible`, `openrouter`, `gemini`, `ollama-native`, `claude-cli`, `codex`), the MCP client and transports, the streaming event vocabulary. MIT/BSD with `NOTICE`; no StarNet branding; renamed to our vocabulary (§7.2) |
| **Rewrite** | the run loop (today it lives inside StarNet and CaPheOS only drives it); run/transcript storage; schedules (→ the dispatcher); seat identity (→ files) |
| **Rewrite small** | the chat run system (`console/chat-runs.js`) against our own runs instead of StarNet's observer feed |
| **Drop** | every game system (floor, props, XP, levels, trophies, battle pass, quests as a StarNet concept), the app builder, channels, voice, StarNet's browser mode (the owner's own Chrome and live desktop — the driver abstraction and the CUA backend are kept, §6.5), skill market, community maps, the station proxy, `lib/station.js`, `station-crew.js`, `station-view.js`, `.starnet-data` |

Quests are the one concept that is dropped as a *word* and kept as a *thing*: CaPheOS's dispatch, handoffs,
competence and evidence all depend on "a unit of work with steps that closes on proof". That is a task.

### 7.1 The core is small; everything else is a plugin

The core is what cannot be removed and still be this product:

| Core | Why it cannot be a plugin |
|---|---|
| HTTP face (console API, runtime API, SSE) | it is the frontend's contract |
| run loop (one turn: model call → tool call → result) | it is the backend's reason to exist |
| provider **interface** (the contract, not any adapter) | the run loop calls it |
| tool host (register, gate, route consent, execute) | the loop calls it |
| task store + transcript store | the record is the company's memory |
| approvals and questions routing | a run that cannot ask is not trustworthy |
| budget enforcement | the same |
| scheduler (the dispatch tick) | the same |

Everything else is a plugin: **shipped with the base**, mounted by configuration, removable without touching the core:

| Plugin family | Examples |
|---|---|
| provider adapters | anthropic, openai-compatible, openrouter, gemini, ollama, claude-cli, codex |
| tool families | shell, filesystem, web, notebook, skills, desktop/browser, MCP |
| integrations | connectors, OAuth sign-ins, service keys |
| seats | role templates, personas, routines |
| surfaces | console panels and pages |
| desktop | the containerized desktop (§6.5) |
| units | the portable modules of `docs/MODULE-SYSTEM.md` — a unit is a plugin with a manifest |

A plugin shipped with the base is enabled in the default composition. A capability the owner adds is a unit. Both are
the same mechanism, so there is one way to extend the backend and one way to remove something.

**The test:** the backend must boot, serve the console and run one turn with the core plus one provider adapter. Every
other plugin is mounted from configuration. If removing something breaks boot, it was core and should be named as core
— not left as a plugin.

### 7.2 How we vendor StarNet

Vendored code is a dependency we own, not an import we trust:

- lives in `vendor/starnet/<name>/` with `LICENSE`, `NOTICE` and `PROVENANCE` (the source commit);
- behaviour is kept; every identifier, string, log line, error and doc comment is renamed to our vocabulary
  (§5, `docs/STYLE.md`);
- no StarNet branding, no station names, no game terms — a vendored file reads as if it were written here;
- mounted as a plugin, never imported by the core;
- a piece that cannot be detached from StarNet's own globals is **refused**: it is a port, not a vendor.

---

## 8. Build-out, with an exit test per phase

**No migration.** A workplace is either on the old stack or on this one; nothing is carried across. New workplaces are
founded fresh from the framework defaults. Existing workplaces are not converted, not read and not upgraded — they keep
running the old stack until they are retired or re-founded by hand. That removes a whole class of work: no compatibility
adapters, no dual-read of the old quest store, no dual-write, no legacy retention rows, and no shims in the new tree.

What replaces migration is **founding**: `scripts/found-company.sh` and `company/defaults/` must produce the new
backend's state directly (tasks, not quests; `company/state/` and `company/work/`, not `.starnet-data/`). Founding is
the only path into a new workplace, and it is tested. The flow — bootstrap, setup, certification, launch — is
`docs/FOUNDING.md`.

**Acceptance is the parity ledger** (`docs/PARITY.md`): 18 areas, three gates, and a bloat ledger where every cut has a
row. The build-out is finished when those gates pass, not when the phase table is empty.

| Phase | Work | Exit test |
|---|---|---|
| **P0** | Freeze the console contract and test it; write the run, task and transcript formats; add the vocabulary lint | the contract test passes against the current console; the formats are reviewed; the lint fails on today's tree with a known list |
| **P1** | The runtime runs one seat's turn with one tool and streams to the console | a chat message gets a streamed reply and a stored transcript, with no station anywhere in the tree |
| **P2** | The work tools (dispatch, inbox, hire, console views) are rewritten on tasks — no adapter for the old store, which is never read | no business tool mentions quests; tasks are the only work model |
| **P3** | Schedules become the dispatcher; the station proxy and the station-only tools are deleted | the dispatcher wakes seats with no station anywhere in the tree |
| **P4** | Providers and spend reach parity; meetings run on the new runtime | a meeting and a routine both run; spend rows match the old ones |
| **P5** | The framework tree carries no StarNet reference; the old stack is left untouched for existing workplaces | `grep -r starnet` is empty in the framework tree |

There is no dual-run switch: a workplace is on one stack. The framework tree becomes the new backend; the old tree stays
frozen for existing workplaces and is out of scope for this work.

The desktop is a second track (`docs/DEPLOY.md` §11): its browser sidecar lands in that plan's P2, its desktop microVM
in P3. The backend's only debt to it is the tool name and the grant gate (§6.5).

---

## 9. Non-goals

We are not rebuilding StarNet. No app builder, no channels, no voice, no skill market, no games, no second UI.
StarNet's browser mode — the owner's own Chrome and live desktop — is not kept; browser and desktop control arrive as
the containerized plugin (§6.5), reusing the driver abstraction and the CUA backend, never as core. Multi-tenant
hosting is out of scope for v1. The unit standard is how new capabilities arrive, but the backend must be useful with
zero units installed.

---

## 10. Decisions

**Taken** (owner, 2026-11-18):

| # | Decision |
|---|---|
| 1 | **One process.** The console HTTP face and the runtime are one program. |
| 2 | **Vendor StarNet with attribution**, abstract each vendored piece into a plugin, ship it with the base, and rename its vocabulary to ours (§7.2). |
| 3 | **Plain language is binding.** ELI5 naming, comments, errors and docs; one noun per thing; `docs/STYLE.md`. |
| 4 | **Desktop/browser is a plugin** on a different framework from StarNet: a containerized desktop (§6.5). |
| 5 | **Core stays minimum.** Anything that can be removed is a plugin (§7.1). |
| 6 | **Naming for the tree:** `server/` (the process), `runtime/` (services and run loop), `company/` (business data and tools), `vendor/` (vendored code). Cheap now, expensive later. |
| 7 | **The desktop follows `docs/DEPLOY.md` §4–§5**: microVM, headed Chrome per identity, the driver abstraction, step-in, grants/leases/revocation. The backend owes it a tool name and the grant gate (§6.5). |
| 8 | **No migration of existing workplaces.** A workplace is on one stack; new workplaces are founded fresh; existing ones are not read, converted or upgraded. Founding (`scripts/found-company.sh` + `company/defaults/`) replaces migration and is tested (§8). |
| 9 | **The acceptance criterion is parity** (`docs/PARITY.md`): functional parity of this deployment, plus the extensibility being added, minus what is carried but unused. Every cut has a ledger row; there are no silent removals. |
| 10 | **Task model:** task = the work item (steps, evidence, closer); commitment = the obligation (ack, due, escalate). Parity requires the same work semantics we run today — the quest model — renamed. |
| 11 | **Run and transcript format** (delegated): append-only JSONL, one stream per run, typed events, stable IDs, a terminal status, retention by policy. |
| 12 | **Dependencies and layout** (delegated): `server/` for the process, `runtime/` for the services and run loop, `vendor/` for vendored code; npm with a lockfile; one pinned dependency (Cordis) in the runtime only, the console and company tools stay dependency-free; SPDX licence plus `NOTICE`; CI runs `npm ci`; the image ships it under the read-only root. |
| 13 | **Founding** (`docs/FOUNDING.md`): `found-company` is the bootstrap; a setup flow collects what the Founder needs — a guided form, or a conversation once one provider key verifies, with AI assistance either way; certification gates launch; the Founder then interviews, hires the bootstrapping crew and scaffolds. Display names are renameable; ids are not. |

**Open:** none. P0 is fully specified — write the task, run and transcript formats; the setup record; the parity test
skeleton; and the vocabulary lint. Then the kept-tool list, and code.
