# Functional parity

**Status:** design, for approval.
**The rule:** the new backend does what this deployment does now, **plus** the extensibility we are adding, **minus**
what we carry but do not use.

---

## 1. What parity is not

Parity is not "StarNet feature-complete". `docs/FEATURES.md` inventories roughly 380 `/api/*` paths across StarNet's
product surface; this deployment uses about thirty endpoint families. Parity is the second number, not the first.

Parity is also not "every file still exists". A tool nobody runs is not parity — it is baggage, and it gets a row in
§4 like everything else.

---

## 2. How parity is proven

Three gates. All three pass before the old stack is considered replaced.

1. **The console contract test.** All 70 console routes answer with the same shapes, so the frontend renders unchanged.
   The frontend is the acceptance test.
2. **The day-in-the-life walk.** One scripted end to end: found a workplace → setup → launch → a seat runs a task →
   an approval → a spend row → a meeting → the dispatcher wakes someone → a backup check. It passes with no station
   anywhere.
3. **The kept tools' selftests.** Every tool in the kept set passes its own `--selftest`; every dropped tool is a row
   in §4 with its reason, never a silent absence.

---

## 3. The parity ledger

| # | Area | Today (evidence) | New home | Parity means | Deliberate change |
|---|---|---|---|---|---|
| 1 | Console surfaces | `console/server.js`, 70 routes; Today, Chat, Crew, Work, Spend, Meetings, Settings, panels | the same routes | the frontend renders unchanged | none |
| 2 | Live chat and runs | `/api/chat/*`, `console/chat-runs.js`; StarNet `/api/run`, `/api/observe`; journal, reattach, final text | runtime runs | stream, reattach, cancel, final text, cost per run | our runs; no observer ring |
| 3 | Work items | quests: 1,687 references across `dispatch.js`, `inbox.js`, `hire.js`, `console/` | tasks | steps, evidence, closure on proof, wake the owner | renamed model; no legacy store |
| 4 | Dispatcher | `dispatch.js` (1,366 lines), `duties.js` (9 duties), lanes, cadence | the same | the same wakes, routes and reasons | no cron; the dispatcher is the only schedule |
| 5 | Approvals and questions | `inbox.js`, `approvals.js`, `/api/questions`, `/api/approvals` | the same | the same gates, answers, snooze, refusals | in-process calls, not HTTP to a station |
| 6 | Budget and spend | `budget.js`, `money-hold.js`, `provider-balance.js`, `subscription-meter.js` | the same | caps, holds, balances, subscription windows, one warning before failure | provider-priced only; no invented estimates |
| 7 | Meetings | `console/meeting.js`, `docs/MEETINGS.md`; turns, pacing, register, minutes | the same | the same protocol and record | runs on the new runtime |
| 8 | Hiring and competence | `hire.js`, `competence.js`, `company/roles/templates/` | the same | the same flows and templates | none |
| 9 | Commitments and handoffs | `modules/commitments`, `company/HANDOFFS.md` | the same | the same state machine and escalation | task and commitment named separately |
| 10 | Core modules | 12 modules: intake, observe, parties, commitments, playbooks, scopes, verify, evidence, reports, ledger, liveness, continuity | the same | enable/disable, tick, routes, panels, limits closed | module packaging moves to units later |
| 11 | Connectors and keys | `connectors.js`, `console/service-keys.js`, OAuth flows, `docs/CONNECTORS.md` | the same | the same sign-in and scoped credentials | the backend owns keys; no station routes |
| 12 | Skills | `company/skills/` (8), skill loading | the skills service | the same files, same loading | none |
| 13 | Governance and decisions | `lib/governance.js`, `decision.js`, `/api/governance`, decisions log | the same | the same gates and records | none |
| 14 | Ops and liveness | `backup-freshness.js`, the liveness module, `service.js`, the updater | the same | the same checks and alarms | updater and desktop runner are host-side (`DEPLOY.md`) |
| 15 | Repos and workspaces | `company/repos/`, `project.js` | the same | file access and project work | "workspace" naming |
| 16 | Browser and desktop | StarNet's host Chrome and Windows CUA; step-in | the desktop plugin | **not parity — this replaces it** | containerized desktop, grants, step-in (`BACKEND.md` §6.5) |
| 17 | Owner channel | `company/owner/*.jsonl`, `/api/owner/*` | the same | the same file adapter and provenance | none |

Areas 1–15 and 17 are parity. Area 16 is the one place we knowingly exceed today's deployment, because the current
mode hands an agent the owner's machine.

---

## 4. The bloat ledger

Carried today, not used, and in the way.

| What | Where it shows up | Cost | Verdict |
|---|---|---|---|
| The station proxy and token | 3,950 references; `lib/station.js`, `console/server.js`, tools, secrets | a second process, port, token and failure mode | delete |
| `.starnet-data/` | quests, roster, agent saves, transcripts | a second state tree with its own formats | delete |
| Quest vocabulary | 1,687 references | game words in business code, docs, routes and UI | rename to tasks |
| Floor and desk vocabulary | 634 + 383 references | describes a station nobody uses | delete; "workspace" where it means a place to work |
| Commander alias | 96 references | a second name for the owner | delete |
| Station port and URL config | `company.json`, tools, docs | configuration for a thing that will not exist | delete |
| StarNet's unused surface | apps, channels, voice, skill market, community maps, props, trophies, XP | ~380 API paths, and gigabytes of UI in the deployment (not in this repo) | delete |
| StarNet's host browser and CUA mode | `browser-*`, `computer-control` | the agent on the owner's machine | replace with the desktop plugin |
| `station-crew.js`, `station-view.js`, station setup | tools and docs | edits another product's state files | delete |
| Service keys through station routes | `console/service-keys.js` | key management owned by another process | own it in the backend |

Every row is a decision, not an assumption: if an item turns out to be used, it goes back to §3 with a parity row.

---

## 5. What "efficiency" means here

- **Fewer moving parts:** one process, no proxy, no second port or token, no cron — the dispatcher already exists.
- **Fewer round trips:** tool calls, approvals and budget checks are in-process calls, not HTTP hops.
- **Fewer prompt tokens:** no station or game vocabulary in the context; a smaller kept tool set; units so an agent
  imports a proven capability instead of authoring one.
- **Fewer stores:** one state tree under `company/`.

Efficiency is a consequence of the cuts, not a separate project.

---

## 6. Acceptance rules

1. **A drop is only a drop when its ledger row says so and that area's test is updated.** Otherwise parity wins.
2. **Extensibility is additive.** Units, MCP and provider plugins must not be required to pass parity.
3. **Every cut gets a row and a date.** The ledger stays live for the life of the rewrite.
4. **A changed route shape ships with the frontend change in the same commit.** The contract test enforces it.
5. **No silent removals.** A tool or route that disappears without a ledger row fails review.

---

## 7. What P0 still has to name

- **The kept tool set.** Which of the 80 `company/tools/*.js` back the ledger areas and duties (kept), and which are
  baggage (dropped). One list, reviewed once.
- **UI copy.** The console's labels change from quests to tasks in one pass at P2 — no migration means no dual wording.
- **The area tests.** One test per ledger area (§3), named in P0 and written as each area lands.
