# Handoff to the coding agent

**Read this fully before writing code.** It is self-contained: the conversation that produced it is gone, and you are
expected to build from these documents, not from guesswork.

**Where the work is:** branch `dsh-4471ef82-5515`, a worktree of `/home/avery/Projects/CaPheOS`. If you are on
`main`, the design documents may be missing — use the branch. The licence set is on the same branch.

---

## 1. The mission in one page

CaPheOS is a framework for running a company staffed by AI agents. It ships **no company** and **no vertical**. The
backend is being replaced:

- **Old:** a StarNet agent runtime reached over HTTP (`co.STATION_URL`, `x-starnet-token`), with agent state under
  `.starnet-data/`, and CaPheOS borrowing StarNet's quests and cron.
- **New:** **one process** that serves the existing console API and runs agents itself. No proxy, no second port, no
  second token, no `.starnet-data`, no station.

The console frontend is unchanged. `docs/CONSOLE-API.md` is the frozen contract.

The rule the owner set: **functional parity of what this deployment does now, plus the extensibility being added,
minus what is carried but unused** (`docs/PARITY.md`). Cordis (MIT) is the plugin standard. The unit system is
`docs/MODULE-SYSTEM.md`.

**No migration.** Existing workplaces keep running the old stack; new workplaces are founded fresh
(`docs/BACKEND.md` §8). There is nothing to convert, no compatibility adapter, no dual read.

---

## 2. Read these first, in this order

Do not read the whole repository. These are the load-bearing documents:

1. `docs/STYLE.md` — plain language is binding. Names, comments, errors. The old vocabulary is banned.
2. `docs/BACKEND.md` — the backend. Read §3, §3.1 (three layers), §6 (the contract), §6.5 (desktop), §7 (core/plugins,
   vendoring), §8 (build-out), §10 (the 14 decisions).
3. `docs/PARITY.md` — the acceptance test: 18 areas, the three gates, and the bloat ledger. Nothing is deleted without
   a row here.
4. `docs/FOUNDING.md` — bootstrap, setup (guided form or conversation), certification, launch. The build profile.
5. `docs/MODULE-SYSTEM.md` — units: manifest, lifecycle, registry, §5.7 (the service surface), §12 (interop).
6. `docs/LICENSING.md` — AGPL-3.0-or-later code, CC BY-NC-SA docs, CLA. Every new source file gets
   `SPDX-License-Identifier: AGPL-3.0-or-later`.
7. `console/chat-runs.js` — the run journal that already exists. You will reuse its shapes.
8. `docs/CONSOLE-API.md` — the routes you must not break.

---

## 3. Non-negotiables

- **One process.** The console server and the runtime are the same Node program. Do not add a second service or port.
- **No station.** New code never calls `co.STATION_URL`, never reads `.starnet-data/`, never writes a station header.
- **No game words.** `station`, `quest`, `commander`, `floor`, `desk`, `battle pass`, `trophy`, `XP` are banned in new
  code, docs, routes, logs and errors. `level` is allowed only for governance (`approve` / `triage`). Run the lint.
- **Cordis is the only dependency.** `cordis@4.0.0-rc.13`, pinned, in `runtime/` only. The console and `company/tools`
  stay dependency-free. A second dependency is a decision for the owner.
- **Behaviour, not files.** The toolbag predates the standard; keep what it does, replace how it is packaged. Expect
  fewer artifacts, not the same ones renamed.
- **No unit mapping, no vertical plan.** The onboarding collects a **build profile**; the **Founder** decides what to
  hire, install and mount. Never hardcode a per-vertical list.
- **A drop needs a row** in `docs/PARITY.md` §4. No silent removals.
- **Tests stay green.** `scripts/test.sh` must pass after every commit. It runs offline, against a temp copy.

---

## 4. Where the code goes

```
runtime/            the new backend (does not exist yet) — one npm package, Cordis
  package.json      type: module, "cordis": "4.0.0-rc.13", no other dependency
  src/index.js      createHost({ root }) — mounts the services
  src/services/     company.js, seats.js, tools.js, runs.js, approvals.js, budget.js
  src/run.js        the turn loop
  src/providers/    openai-compatible.js, fake.js (offline tests)
  src/tools/        fs-read.js (path-jailed); more arrive as units
  src/formats.js    task, run journal, transcript, build profile readers/writers
  schemas/          task.schema.json, run-journal.schema.json, transcript.schema.json, build-profile.schema.json
  test/             node:test files, offline
server/             the HTTP face — P1 reuses console/server.js, adds /api/runtime/*
vendor/             vendored third-party code, with NOTICE row (empty for now)
```

Do **not** rewrite `console/server.js` in P1. Mount the runtime beside it and add the routes. P3 deletes the station
path.

---

## 5. P0 — write these four formats first

These are decided. Write them as JSON Schema files plus a short doc section, then implement the readers and writers in
`runtime/src/formats.js`. Nothing else compiles without them.

### 5.1 Task — `company/work/tasks/<id>.json`

```json
{
  "format": 1,
  "id": "task-20261118-a1b2c3",
  "title": "One line",
  "summary": "What done looks like, in plain words.",
  "state": "open | in_progress | blocked | done | verified | closed | cancelled",
  "owner": "ceo",
  "steps": [{ "id": "s1", "text": "…", "done": false, "evidence": ["ev-…"] }],
  "evidence": [{ "kind": "file | url | run | row", "ref": "…", "at": "…" }],
  "contract": { "type": "file | url | json | attest", "key": "…" },
  "createdAt": "…", "updatedAt": "…", "closedAt": null,
  "source": { "kind": "owner | handoff | intake | dispatcher", "ref": "…" }
}
```

- transitions append to `company/work/tasks/tasks.jsonl`: `{ at, id, from, to, by, note }`;
- **a task closes on evidence, not on a click**: `done` requires every step done and the contract satisfied; `closed`
  after the verify seat accepts it;
- `contract` is optional; a task with no contract closes on its steps;
- the v1 quest store is never read (`docs/PARITY.md` §4).

### 5.2 Run journal — `company/state/runs/<runId>.ndjson`

Reuse the shapes `console/chat-runs.js` already writes, minus the station cursor `c`:

```json
{"name":"run.start","payload":{"runId":"…","seat":"ceo","source":"console"}}
{"name":"text","payload":{"text":"…"}}
{"name":"tool.start","payload":{"callId":"…","tool":"fs.read","args":{}}}
{"name":"tool.result","payload":{"callId":"…","ok":true,"result":{}}}
{"name":"approval.ask","payload":{"questionId":"…","text":"…"}}
{"name":"usage","payload":{"input":0,"output":0,"cost":null}}
{"name":"console.final","payload":{"text":"…","complete":true}}
```

- run row in `company/state/runs.json`: `{ runs: { <runId>: { seat, status, startedAt, endedAt, reason, userText,
  source } } }`;
- statuses: `running | done | refused | cut | failed`;
- the console re-attaches with the line count it already has; the server replays from there. That is the whole
  re-attach mechanism — do not invent another.

### 5.3 Transcript — `company/state/transcripts/<runId>.jsonl`

The canonical record used for context and audit. One line per message part:

```json
{"seq":1,"at":"…","role":"user|assistant|tool","content":[{"type":"text","text":"…"}]}
{"seq":2,"at":"…","role":"assistant","content":[{"type":"tool_call","callId":"…","tool":"fs.read","args":{}}]}
```

- the run's context on the next turn is assembled from this file, not from the journal;
- refusal is a normal assistant line plus a `run.end {status:"refused"}`; never rewrite the prompt to dodge it.

### 5.4 Build profile — `company/state/build-profile.json`

Produced by setup and certification, read by the Founder at launch. **Nothing in it names a unit.**

```json
{
  "format": 1,
  "createdAt": "…", "certifiedAt": "…",
  "identity": { "companyName": "…", "slug": "…", "owner": { "name": "…", "addressAs": "…" }, "timezone": "…", "locale": "en", "currency": "USD" },
  "business": { "purpose": "…", "vertical": "fintech", "stage": "new | existing | pivot", "sells": ["…"], "customers": "…" },
  "needs": { "firstThirtyDays": "…", "firstThreeItems": ["…"], "constraints": ["…"], "functions": ["ceo","people","tools","risk","finance"] },
  "access": { "autonomy": "…", "approvalThresholds": {}, "externalActions": "…", "dataHeld": ["…"] },
  "ai": { "providers": [{ "id": "openai-compatible", "verified": true }], "modelPolicy": {}, "spendCapUsd": 0, "pacing": {} },
  "crewIntent": { "hireAtLaunch": [] },
  "source": { "bootstrap": "found-company.sh", "setup": "form | conversation" }
}
```

### 5.5 Also in P0

- **Parity test skeleton** in `tests/parity/`: `area-01-console.test.js` … `area-18-refusals.test.js`, one per area,
  plus a runner. Start with the three gates that can run offline: the console contract test, the kept tools' selftests,
  and the day-in-the-life fixture.
- **Vocabulary lint**: `scripts/vocab-lint.js`, scanning `docs/`, `runtime/`, `server/`, `company/`, `console/` for the
  banned words, with `scripts/vocab-allow.txt` (`path:word:reason`). Wire it into `scripts/test.sh`.

---

## 6. P1 — one turn, streamed, no station

**Exit test:** a chat message gets a streamed reply and a stored transcript, with `STATION_URL` dead.

1. `runtime/package.json` + `npm install --package-lock-only` to pin Cordis. `npm ci` in CI.
2. `runtime/src/index.js`: `createHost({ root })` — a Cordis `Context`; mount `company`, `seats`, `tools`, `runs`.
   The services read `<root>/company/company.json`, `company/tools/loops.json`, `company/state/units.json`.
3. `runtime/src/providers/openai-compatible.js` — the provider contract: `stream(request)` yields
   `{ type: "text" | "tool_call" | "usage" | "done" | "refusal" }`. Key from `secrets/deepseek-key` through the company
   seam. `runtime/src/providers/fake.js` replays a scripted sequence for tests.
4. `runtime/src/run.js` — one turn: assemble the seat's prompt (charter from `company/roles/<id>.md`, skills, the task,
   the transcript tail) → provider stream → tool calls → approval if needed → journal + transcript → `console.final`.
5. `runtime/src/tools/fs-read.js` — one read-only tool, path-jailed. Nothing else in P1.
6. Routes in `console/server.js`: `POST /api/runtime/runs`, `GET /api/runtime/runs/<id>`,
   `GET /api/runtime/runs/<id>/stream?from=<n>` (SSE), `POST /api/runtime/runs/<id>/cancel`. The existing
   `/api/chat/*` routes switch to these for a workplace on the new backend.
7. Keep the station proxy and the old tools untouched; P3 deletes them.

**P1 may call the existing `company/tools/*.js` as child processes** (approvals, budget). They become services in P2.
That is the pragmatic path and it preserves parity.

---

## 7. P2–P5

`docs/BACKEND.md` §8 has the phases and exit tests. In short: P2 rewrites the work tools on tasks; P3 moves schedules to
the dispatcher and deletes the station code; P4 reaches provider/spend parity and runs meetings; P5 leaves no StarNet
reference in the tree. Do not start a phase before its predecessor's exit test passes.

---

## 8. Testing rules

- `scripts/test.sh` is the whole offline suite. It copies **tracked files** to a temp directory and points
  `CAPHEOS_ROOT` at the copy; nothing touches the checkout. It must stay green.
- The runtime needs `node_modules`, so it is tested by a **separate** script and CI job: `scripts/test-runtime.sh`
  (`npm ci --prefix runtime && node --test runtime/test/`). Do not put Cordis tests inside `scripts/test.sh`.
- **Offline only.** Provider tests use `fake.js`; no network, no keys, no station.
- The parity console test starts `console/server.js` against a temp root and asserts every frozen route's shape.
- A test that needs a live model is not a test; it is a manual smoke, documented in the README of the runtime.

---

## 9. Traps that get a change rejected

- Rewriting `console/server.js` instead of adding to it.
- Adding a dependency.
- Deleting a tool or route without a `docs/PARITY.md` row.
- A new code path that reads `.starnet-data/` or calls the station.
- A game word anywhere visible.
- A per-vertical list, a unit mapping, or a "declared stack".
- A test that needs network or a real key.
- A commit without `scripts/test.sh` passing.

---

## 10. Open items owned by the human

| Item | Owner | Blocks |
|---|---|---|
| units repo name and host (`capheos-units` placeholder) | owner | publishing, P3+ |
| counsel review of `CLA.md` and the commercial terms | owner | the first commercial licence |
| the legal entity on the copyright line (`NOTICE`) | owner | nothing immediate |
| a real provider key in the dev environment | owner | manual smoke only; CI uses the fake |
| merging branch `dsh-4471ef82-5515` | owner | sharing the design |

---

## 11. Definition of done, first week

1. The four schemas in `runtime/schemas/` and their readers/writers.
2. The vocabulary lint, wired into `scripts/test.sh`.
3. The console contract test.
4. A runtime that boots with the fake provider, runs one turn, writes the journal and the transcript, and streams SSE.
5. `scripts/test-runtime.sh` green; `scripts/test.sh` still green.
6. Committed in small steps, each with a message that says what behaviour changed and why.

Then the first real provider, the first work tool, and the first parity area lands.

---

## 12. How to report back

- Commit per step, message style like the existing history: what changed, why, and the test that proves it. Long is
  fine; vague is not.
- When a design document is wrong or incomplete, say so and propose the change; do not silently diverge.
- When a decision looks wrong, stop and ask. The owner has been explicit: parity, openness, the standard, no bloat.
