# Core modules

CaPheOS is strong at **Act** (permissions, clearances, audit) and at stopping. A real business also has to **Sense**
(take events in), **Organize** (track who and what it owes), **Verify** (prove outcomes), **Settle** (get paid) and
**Guarantee** (stay alive, hand over cleanly). Those layers are the same for every vertical; only the nouns change
(alerts, orders, leads, filings, tickets). They ship as **core modules**: generic plumbing that packs build on.

Modules follow the pack scaffold rules (docs/PACKS-SPEC.md): docs always readable; tools absent until enabled; limits
closed; meters locked on enable. Enabled with `node company/tools/module.js enable <id> --by <owner>` (governance
category `packs`), listed in `company/state/modules.json`. A pack declares the modules it needs in `requires`.

## The stack

| Layer | Module | Gives the company | Enable when |
|---|---|---|---|
| Sense | `intake` | inbound signals: `POST /hooks/<source>` on the console server (per-source secret, HMAC or token, size cap, replay window), plus mailbox/feed pollers that normalise into the same event shape; every event lands in `company/work/intake/events.jsonl` with a dedupe key | the world must push events in, with no polling equivalent |
| Sense | `observe` | watched targets with history: declarative probes (http status/latency, json path value, file digest, command exit) on a cadence, results appended to `company/work/observe/<target>.jsonl`, change and threshold events emitted to intake | something outside must be watched over time |
| Organize | `parties` | registry of outside parties (`company/work/parties/<id>/party.json`), per-party data folder, isolation: tools resolve party data only through `parties.path(id, …)`, and a run working for one party is told and logged with that party id | more than one outside party |
| Organize | `commitments` | a state machine for anything that can be lost: `received → acknowledged → in_progress → done → verified → closed` (plus `suppressed`, `cancelled`, `breached`), dedupe key, owner seat, ack deadline, due time, party id, playbook id, evidence refs; the dispatcher wakes owners, re-escalates an unacknowledged commitment up the chain of command, and flags breaches | a request, order, job or lead can be lost |
| Organize | `playbooks` | situation → procedure: match rules over event fields (`source`, `type`, json-path predicates) choose a playbook (`company/work/playbooks/<id>.md` + `.json`: steps, owner function, clocks, verify spec); intake + playbooks create the commitment | repeatable work where quality matters |
| Act | `scopes` | per-party credentials: `secrets/parties/<id>/<name>` with a scope record (read-only / write, rotate-by date, owner), resolved only through `scopes.secret(party, name)`; read-only by default; rotation reminders | outside parties give you access |
| Verify | `verify` | independent outcome checks run by the dispatcher (a non-agent process), never by the seat that did the work: declarative checks on a `done` commitment (http, json path, file digest, a second model family's judgement with a fixed rubric) → `verified` or back to `in_progress` with the failure | you are paid or blamed on claims |
| Verify | `evidence` | per-party exportable trail: `evidence.js export --party <id> --from --to` → a folder/zip of events, commitment histories, verify results, external-gate rows and provenance with a digest manifest | disputes are possible |
| Settle | `reports` | periodic outcome reports per party (template + data from commitments/observe), drafted, reviewed, sent only through the external gate | there is a counterparty to report to |
| Settle | `ledger` | invoices, receipts, payouts, an append-only revenue ledger separate from AI spend; invoice from delivered commitments; sending and payment links through the external gate; reconcile by a seat other than the one that invoiced | there is a revenue relationship |
| Guarantee | `liveness` | dead-man's switch: the dispatcher writes a heartbeat; a separate systemd timer (not the station, not the dispatcher) checks heartbeat age and alerts the owner (console + optional push adapter + optional external ping URL); and the watcher's own heartbeat is checked by the dispatcher, so each watches the other | you promise coverage or availability |
| Guarantee | `continuity` | wind-down and handover: soft halt lists open commitments by party and due time, lets the owner reassign or notify parties (gated), and refuses to settle while a breach-able commitment is unowned | there are live obligations to outside parties |

## Shared shapes

- **Event** (`intake`, `observe`): `{ id, at, source, type, key, party?, data, receivedVia, trust }` — `key` is the dedupe key;
  `trust` is `untrusted` unless the owner marks the source `internal` (intake `limits/sources.json`); untrusted data reaches
  an agent only fenced (`lib/untrusted.js`). A source or target may declare `expect: { maxSilenceMin, minPerHour?,
  activeHours?, days?, tz? }`; quiet past it emits a `silence` event (intake README).
- **Idempotent sends:** every module send passes `idem` (derived from what is sent) to `external-gate.js`; a repeat
  key is answered `duplicate` (exit 4) with the prior attempt id (`company/work/external-idempotency.jsonl`; TTL
  forever for spend/publish, 24 h for message).
- **Commitment**: `{ id, key, party?, title, state, owner, createdAt, ackBy, dueAt, playbook?, history:[{at, from, to, by, note}], evidence:[ref], verify?: spec }`, stored one file per commitment under `company/work/commitments/` plus an append-only `commitments.jsonl` of transitions.
- Every module ships `--selftest`, a conformance test, an INVENTORY.md row, and console panels (via the console-panel contract) where the owner would look at it.

## The module mechanism

From the console: Settings › System › Modules switches a module on or off as the owner (`POST /api/ops/modules/<id>/enable|disable`).
Tool: `company/tools/module.js` (`list`, `status <id>`, `doctor [<id>|--all]`, `enable|disable <id> --by owner`,
`gates`, `selftest`). Runtime hooks: `company/tools/lib/modules.js`. Registry: `company/state/modules.json` (only
module.js writes it; locked-watch class F, owner risk). Log: `company/state/modules-log.jsonl`.

```
modules/<id>/
  module.json        pack.json shape (company/schemas/pack.schema.json) + "layer" (sense|organize|act|verify|settle|
                     guarantee) + "enableWhen" (one sentence); requires.modules = modules that must be enabled first;
                     limits may be []; meters p anywhere under company/work/ or company/state/
  README.md, docs/   always readable
  tools/<file>       each listed in tools[], each with --selftest; copied FLAT to company/tools/<file> on enable
                     (refused if that name is taken by a non-module tool), removed on disable
  rows.md            optional: "## INVENTORY", "## 5a", "## 7b" sections of markdown table rows for the tools;
                     generated from tools[] (purpose, owner, --selftest) when absent. enable writes them to the
                     gitignored company/state/inventory-local.md (never the tracked INVENTORY.md / runbook), disable
                     removes them; tool-inventory-check.js and doctor read it with the tracked files
  tick.js            optional: module.exports = { tick: async ({ log, dry, co, id, halted }) => any,
                     runWhenHalted?: true, timeoutMs?: 60000 }
  http.js            optional: module.exports = { routes: [{ method, path, auth: 'owner'|'source', handler(req, res, ctx) }] }
  panels/<panel>/    console panels, added on enable
  conformance/test.js  exit 0 when the contract is met; env MODULE_DIR, MODULE_ROOT, MODULE_ENABLED (1|0),
                     MODULE_TOOLS_DIR (also PACK_* for template compatibility)
```

- **Enable** (owner only, refused inside a station run; governance category `packs` recorded): static checks (schema,
  listed files, closed limits, `--selftest` in every tool, tick.js/http.js parse), `requires` (incl. `modules`),
  conformance test; then tools copied, empty meter files created, meters + tools + tick.js/http.js/module.json
  registered in `company/state/locked-extra.json` (entries tagged `module: <id>`), rows added, allowlist hosts tagged
  `# module:<id>`, panels added, owner told. Any failure rolls back. **Disable** is refused while an enabled module or an
  installed pack requires it; meter records are kept.
- **Doctor** fails an enabled module when a tool is missing or changed, a meter is unregistered, a row is missing, the
  module folder changed since enable (disable + enable to take a change), a requirement broke, or its test fails.
- **Limits:** shipped closed in `modules/<id>/limits/`; the owner opens one with `module.js limits <id> set <file>
  <key.path> <number> --by owner`, which writes `company/state/modules/<id>/<file>` (registered on enable as
  `company/state/modules/<id>/limits/**`, class F, writer module.js). Tools read the opened copy first and fall back to
  the shipped closed one (`lib/modules.js limitsFile(id, file)`); missing or unreadable = closed.
- **Safe defaults (read-only modules only):** a module with `layer: "sense"` may give a limit entry a `defaults`
  object of numbers. When the owner enables it, those become the opened copy (unless one already exists), so a
  read-only reader works without a `limits set` call first. A module that acts, settles or spends cannot ship
  defaults: `module.js` refuses the manifest.
- **Ticks:** the dispatcher runs ONE hook after the halt tick: each enabled module's `tick.js` by `module.json`
  `order` (lower first, default 100; intake → playbooks → commitments → verify), then id,
  fail-safe (throw/timeout = one `MODULE <id> TICK ERROR` log line). A halted company runs only `runWhenHalted` modules.
- **Routes:** the console mounts each enabled module's `http.js`: `auth: 'source'` → `/hooks/<id>/<path>` (no owner
  token; the module authenticates the caller, e.g. HMAC over the raw body), `auth: 'owner'` → `/api/m/<id>/<path>`.
  `path` segments may be `:name`. Bodies are raw, capped at 256 KB (413). `ctx = { id, params, query, body (Buffer),
  text, json(), headers, owner, co, send(status, obj) }`; return an object (sent as JSON 200) or answer on `res`.
- **Requiring lib/company.js** from a module tool that runs both in `modules/<id>/tools/` and, once enabled, in
  `company/tools/`: `const co = require(require('fs').existsSync(__dirname + '/lib/company.js') ? './lib/company' :
  '../../../company/tools/lib/company');` (tick.js / http.js: `require('../../company/tools/lib/company')`).
- A pack names the modules it builds on in `pack.json` `requires.modules`; pack.js refuses to install until they are
  enabled and conformant.

## Onboarding is certification, not provisioning

Two states, never conflated:

- **provisioned**: files written, station installed, secrets created (`found-company.sh`, `setup-station.sh`).
- **certified**: `node company/tools/onboard.js --certify` is green. A company is not operational until it can prove it is.

`company/tools/onboard.js` (`--check`, `--resume`, `--certify`, `--teardown`, `--selftest`) keeps
`company/state/onboarding-state.json` plus a per-step ledger (the `patches/*.applied` / `guardrails-applied.json`
pattern; replaces the bare `.founded` stamp). Deterministic, re-runnable, safe to interrupt, fails closed; no wizard.

Certification refuses until each is verified, not assumed:

1. station answers `GET /api/cron` with the token;
2. the dispatcher wrote `dispatch-log.md` within one tick;
3. `guardrails.js apply --dry-run` clean, then applied;
4. every enabled pack's and module's required secrets present, non-empty, mode 0600;
5. `company/work/ops/health-targets.json` and `ops/backups.json` registered, and one backup verified;
6. the dead-man's switch (`liveness`) registered and pinged once;
7. `pack.js doctor --all` green;
8. the charter has no `{{COMPANY}}` / `<...>` placeholders;
9. the console answers `/api/company` with the owner token.

Owner gates a pack's requirements resolve to (accounts, credentials, spend, outside commitments) are asked once, at
founding, as one batch of questions on Today, and the answers recorded in the ledger. Preflight and idempotent resume
for both scripts; `--check` for `found-company.sh`. The console shows a provisioning/certification panel (per step:
status and what is missing). Multi-tenant extras (port pool, per-tenant secret namespaces, an isolation check,
`--teardown --tenant` that stops units and archives data) come with the second client.
