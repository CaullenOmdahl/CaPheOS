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

- **Event** (`intake`, `observe`): `{ id, at, source, type, key, party?, data, receivedVia }` — `key` is the dedupe key.
- **Commitment**: `{ id, key, party?, title, state, owner, createdAt, ackBy, dueAt, playbook?, history:[{at, from, to, by, note}], evidence:[ref], verify?: spec }`, stored one file per commitment under `company/work/commitments/` plus an append-only `commitments.jsonl` of transitions.
- Every module ships `--selftest`, a conformance test, an INVENTORY.md row, and console panels (via the console-panel contract) where the owner would look at it.

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
