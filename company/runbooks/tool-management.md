# Tool Management Runbook

Owner: the tools function. Mandate: `tool-management` in `company/mandates.json`. Station: the StarNet checkout at
`./starnet`; its URL comes from `co.STATION_URL` (`company/tools/lib/company.js`).

## 1. Ownership

**Tools owns:** `company/tools/*`, `company/tools/INVENTORY.md`, `company/skill-installs.jsonl`, skill propagation,
agent tool and model configuration, station service operations, and `company/patches/`.

| Decision | Who |
|---|---|
| Tooling, config, CI, skill rollout, restarts, tool replacement within the existing budget | tools, no approval |
| A tool that touches credentials or tokens, or changes the network bind | tools proposes, **risk reviews** before it goes live |
| A tool with a new cost (subscription, API usage, seat) | tools proposes, **finance prices** before adoption |
| Cross-team impact, roster changes, priority conflicts | **the CEO** |
| Money, access, ownership, commitment | **the owner** (the four gates in `company/DECISION_RIGHTS.md`), via the CEO |

## 2. Skill propagation

Required on every agent: the skills listed as required in `company/skills/` (at least `refusal-escalation`,
`project-takeover`, `mandate-intake`, `chain-of-command`).

When a skill is added or changed:
1. Edit `company/skills/<name>/SKILL.md`. Keep the diff minimal.
2. Baseline: `node company/tools/skills.js status`, then `node company/tools/skills.js verify`. Record gaps that
   existed before the change.
3. Preview: `node company/tools/skills.js install-all --dry-run`.
4. Install: `node company/tools/skills.js install <name> --agents all`.
5. Re-verify: `node company/tools/skills.js verify`. Done only when every agent shows every required skill at the
   current content.
6. Audit: confirm new lines in `company/skill-installs.jsonl`. Never edit that file by hand.

If verify shows gaps: install on the missing agents (`--agents <a,b>`) and verify again; if a gap persists, check
station health (section 4), read the error in the jsonl entry, retry once, then go to the failure playbook. Never
report "propagated" without a clean verify run.

## 3. Adding or configuring an agent

1. Hire through `company/tools/hire.js` (the people function's process); do not hand-create agents.
2. Model and provider follow `company/MODEL_POLICY.md`. A different paid provider or tier goes to finance first.
3. Install the required skills and verify the roster with `skills.js status`.
4. Verify runtime: the agent appears in the station UI and answers a trivial directive on the configured model. If
   this cannot be checked, report it as assumed.
5. Update `company/tools/INVENTORY.md` if the agent adds a tool or credential.
6. Tell the CEO: agent id, role, model/provider, skills verified, and what was not checked.

## 4. Station operations

The station runs as a service (for example a systemd user unit with `Restart=always`).

- Health: `curl -s "$STATION_URL/api/health"`.
- Logs: `.starnet-data/station.log` (the unit appends there, not to the journal); older ones are `station.log.N.gz`,
  rotated by `company/tools/retention.js` past 50 MB. Every growing file's bound: `node company/tools/retention.js status`
  (`audit` exits 1 when one is over; docs/RETENTION.md).
- Restart: check health and for active runs first, restart, wait, re-check health. Tell the CEO if runs were cut off.
- **Down:** status, the last log lines, then the cause (port in use, bad env file, missing dependency, crash loop). Fix
  the one cause, restart once, re-check. A crash loop means stop restarting and read the logs.
- **Env file:** keep it at mode 0600 and never commit it.
- **Network bind:** binding beyond loopback (patch `0001`) exposes the API and UI to the network, and agents can run
  commands and write files. The bind and its host allowlist are a risk-reviewed setting. Revert by binding to
  `127.0.0.1` and restarting.
- **StarNet patches:** every change to StarNet's own code is a record in `company/patches/` (see its README).
- **Headless station (no save, no Founder):** a station started with `STARNET_HEADLESS=1` (patch `0010`) never serves
  the page, so the page never creates the station save or pushes the roster: `GET /api/save` answers `{save:null}`,
  the Founder is only the engine's implicit default agent (no dossier, no approval mode, unattended writes refused),
  and `hire.js`, `station-crew.js` and `dossier.js` stop at "GET /api/save returned no save". Fix:
  `node company/tools/station-seed.js status`, then `node company/tools/station-seed.js seed --by <owner>`. It runs
  StarNet's own terminal WAKE (`starnet/bin/lib/awaken.js`, the app's modules via `app-modules.js`): the starter
  station named after the company, the Founder (id `agent`) with its dossier from `company/roles/agent.md`, the
  roster row with the composed prompt, and the approval mode self-governance gives (`full` when `tools` is auto or
  notify and harnessSelfEdit is off or guarded by a locked-watch baseline; `ask` otherwise, with the reason). It
  skips the awakening's lock-down resets (grants, posture, journey, memory): they would undo the company's setup.
  Idempotent; back up `.starnet-data/workspaces` first on a live station.

## 5. Tool inventory

File: `company/tools/INVENTORY.md`, one row per tool:

| tool | purpose | owner | credentials | cost | last verified |
|---|---|---|---|---|---|

The credentials column holds the secret's **name** (`secrets/<name>`) only, never the value.

**Weekly check:** health endpoint, `skills.js verify`, each script's help or `--selftest` mode, secret files are 0600,
provider usage against the cost column. Update "last verified" only for what was actually run.

`node company/tools/tool-inventory-check.js` checks that the inventory is true: it fails when a row names a file that is
gone, when a checker has lost its `--selftest`, or when a script under `company/tools/` is documented nowhere. Known
debt is declared in a baseline file that **only shrinks**: document a tool and delete its line. Never add a line to
silence a finding.

### 5a. Every script in company/tools/

The check below reads this table: every script directly under `company/tools/` has a row. Paths here are written
**without** backticks on purpose — a backticked path in a table row is a claim that the tool has a `--selftest`, and
that claim belongs in the §7b table. Purpose, CLI and credentials per tool are in the inventory file.

| tool | owner | selftest |
|---|---|---|
| company/tools/agy-contract.js | tools | none |
| company/tools/ask.js | ceo | none |
| company/tools/backup-freshness.js | risk | `--selftest` |
| company/tools/build-inventory.js | people | `--selftest` |
| company/tools/cadence.js | tools | `selftest` / `--selftest` |
| company/tools/cap-numerator.js | finance | `--selftest` |
| company/tools/competence.js | people | `selftest` |
| company/tools/connector-scope.js | risk | `--selftest` |
| company/tools/console-panel.js | tools | `selftest` |
| company/tools/corrections.js | people | `selftest` |
| company/tools/decide.js | risk | `selftest` / `--selftest` |
| company/tools/decision.js | ceo | `selftest` |
| company/tools/default-branch-watch.js | risk | `selftest` |
| company/tools/delegation.js | ceo | `selftest` / `--selftest` |
| company/tools/dispatch.js | tools | `--selftest` |
| company/tools/dispatcher-loop.js | tools | `selftest` / `--selftest` |
| company/tools/dossier.js | people | none |
| company/tools/duties.js | tools | `--selftest` |
| company/tools/duty-status.js | tools | `--selftest` |
| company/tools/escalate.js | ceo | none |
| company/tools/external-gate.js | risk | `--selftest` |
| company/tools/founder-loop.js | ceo | `--selftest` |
| company/tools/governance.js | ceo | `selftest` / `--selftest` |
| company/tools/guardrails.js | risk | `selftest` |
| company/tools/halt.js | ceo | `selftest` / `--selftest` |
| company/tools/handoff-archive.js | tools | none |
| company/tools/handoff-status.js | tools | `--selftest` |
| company/tools/harness-change.js | tools | `selftest` |
| company/tools/health-check.sh | tools | `--selftest` |
| company/tools/hire.js | people | `selftest` / `--selftest` |
| company/tools/inbox.js | ceo | none |
| company/tools/incident-open.py | risk | none |
| company/tools/lanes.js | tools | none |
| company/tools/locked-watch.js | risk | `selftest` / `--selftest` |
| company/tools/long-sleep.js | tools | `--selftest` |
| company/tools/mandate.js | ceo | none |
| company/tools/merge-gate.js | risk | `selftest` |
| company/tools/model-drift.js | people | `--selftest` |
| company/tools/model-stats.js | people | none |
| company/tools/models.js | people | `selftest` |
| company/tools/module.js | ceo | `selftest` / `--selftest` |
| company/tools/my-section.js | people | `selftest` |
| company/tools/offpeak-clocks.js | finance | `--selftest` |
| company/tools/offpeak-hold.js | finance | `--selftest` |
| company/tools/offpeak-proof.js | finance | `--selftest` |
| company/tools/onboard.js | ceo | `--selftest` |
| company/tools/openrouter-treasury.js | finance | none |
| company/tools/owner-addressing.js | ceo | `--selftest` |
| company/tools/owner-inbox.js | ceo | `--selftest` |
| company/tools/pack.js | ceo | `selftest` / `--selftest` |
| company/tools/pacer.js | finance | none |
| company/tools/performance.js | people | none |
| company/tools/premerge-check.js | risk | `--selftest` |
| company/tools/project.js | ceo | none |
| company/tools/provenance.js | risk | `selftest` |
| company/tools/providers.js | ceo | `selftest` |
| company/tools/quest-audit.js | tools | `--selftest` |
| company/tools/restart-station-idle.sh | tools | `--selftest` |
| company/tools/restart-station.js | tools | `selftest` |
| company/tools/retention.js | tools | `selftest` |
| company/tools/routine-length.js | people | none |
| company/tools/routine-rules.js | tools | `selftest` / `--selftest` |
| company/tools/skills-hr.js | people | `selftest` |
| company/tools/skills.js | tools | `selftest` |
| company/tools/station-crew.js | people | none |
| company/tools/station-floor.js | floor | none |
| company/tools/station-seed.js | ceo | `selftest` / `--selftest` |
| company/tools/station-view.js | tools | `selftest` |
| company/tools/text-corruption.js | finance | `--selftest` |
| company/tools/tool-inventory-check.js | tools | `--selftest` |
| company/tools/tool-parse.js | tools | `--selftest` |
| company/tools/vision.js | tools | none |
| company/tools/workspace-modes.sh | risk | `--selftest` |

**Rotation:** every credential has a rotation date in the inventory. Tools prepares; the rotation itself is a
risk-reviewed action, and creating or reissuing a credential is an owner gate. A credential rotated out of band
(exposure, loss) restarts its clock and is reported to risk at once.

## 6. Security and cost

- **Risk review triggers:** a tool that reads, stores or sends credentials; a new token; new network exposure; a change
  to the bind; a tool that executes remote input.
- **Finance triggers:** a new paid tool, plan upgrade, new provider, or a measurable usage increase.
- **Secrets:** read them only through `co.secret(name)` / `co.stationToken()`. Never print, log, paste or copy them into
  docs, handoffs or chat. If a secret appears in output, treat it as exposed and rotate it.
- **Party credentials** (module `scopes`): `secrets/parties/<party>/<name>`, 0600, read only through
  `scopes.secret(party, name)`, which refuses a write-scope key to a caller asking for read; `scopes.js check` (daily
  from its tick) fixes modes and emits rotation-due events.
- **Core-module tools** (scopes, verify, evidence, reports, ledger; `modules/<id>/`): absent until
  `module.js enable <id> --by owner`, which copies them here and writes their §5a/§7b rows from `modules/<id>/rows.md` to the instance-local
  `company/state/inventory-local.md` (gitignored; tool-inventory-check.js reads it with this runbook).
  Their shared library is `company/tools/lib/settle.js` (on top of `lib/modkit.js`). Every send they make (report,
  invoice, payout, a verify http check) goes through `external-gate.js`, sends with an idempotency key derived from
  what is sent (`--idem`; a retry is answered duplicate, exit 4, never sent twice); their limits ship closed (`ledger` sends no
  invoice until the owner sets `currency`). Separation of duties: `verify.js mark` refuses the seat that did the work,
  `ledger.js reconcile` refuses the seat that invoiced, `hire.js hire` refuses a hire that would hold a seat and
  anything on its `independentOf` list. Intake events are `trust: 'untrusted'` (only the owner marks a source internal);
  a tool that puts event data in a handoff or prompt fences it with `lib/untrusted.js`, never in a routine prompt.

## 7. Checkers must be seen failing

A checker is not finished until someone else can see it refuse. Every gate, linter or guard in `company/tools/` has a
`--selftest` that builds a fixture and **fails** when the guard is removed, not one that merely passes. Its inventory
row names the command that passes and the mutant or fixture that shows it failing. Assert the *kind* of finding, not a
count: a count cannot tell a right failure from a wrong one.

### 7b. Selftest table

Every tool listed here carries `--selftest` in its own source and passes the command shown, offline (`scripts/test.sh`
runs them all against a temp copy with no station). A tool whose selftest is only a `selftest` subcommand is marked so
in §5a instead.

| tool | owner | passes |
|---|---|---|
| `company/tools/backup-freshness.js` | risk | `node company/tools/backup-freshness.js --selftest` |
| `company/tools/build-inventory.js` | people | `node company/tools/build-inventory.js --selftest` |
| `company/tools/cadence.js` | tools | `node company/tools/cadence.js selftest` |
| `company/tools/cap-numerator.js` | finance | `node company/tools/cap-numerator.js --selftest` |
| `company/tools/connector-scope.js` | risk | `node company/tools/connector-scope.js --selftest` |
| `company/tools/decide.js` | risk | `node company/tools/decide.js selftest` |
| `company/tools/decision.js` | ceo | `node company/tools/decision.js selftest` |
| `company/tools/delegation.js` | ceo | `node company/tools/delegation.js selftest` |
| `company/tools/dispatch.js` | tools | `node company/tools/dispatch.js --selftest` |
| `company/tools/dispatcher-loop.js` | tools | `node company/tools/dispatcher-loop.js selftest` |
| `company/tools/duties.js` | tools | `node company/tools/duties.js --selftest` |
| `company/tools/duty-status.js` | tools | `node company/tools/duty-status.js --selftest` |
| `company/tools/external-gate.js` | risk | `node company/tools/external-gate.js --selftest` |
| `company/tools/founder-loop.js` | ceo | `node company/tools/founder-loop.js --selftest` |
| `company/tools/governance.js` | ceo | `node company/tools/governance.js selftest` |
| `company/tools/halt.js` | ceo | `node company/tools/halt.js selftest` |
| `company/tools/handoff-status.js` | tools | `node company/tools/handoff-status.js --selftest` |
| `company/tools/health-check.sh` | tools | `bash company/tools/health-check.sh --selftest` |
| `company/tools/hire.js` | people | `node company/tools/hire.js selftest` |
| `company/tools/locked-watch.js` | risk | `node company/tools/locked-watch.js selftest` |
| `company/tools/long-sleep.js` | tools | `node company/tools/long-sleep.js --selftest` |
| `company/tools/model-drift.js` | people | `node company/tools/model-drift.js --selftest` |
| `company/tools/module.js` | ceo | `node company/tools/module.js selftest` |
| `company/tools/offpeak-clocks.js` | finance | `node company/tools/offpeak-clocks.js --selftest` |
| `company/tools/offpeak-hold.js` | finance | `node company/tools/offpeak-hold.js --selftest` |
| `company/tools/offpeak-proof.js` | finance | `node company/tools/offpeak-proof.js --selftest` |
| `company/tools/onboard.js` | ceo | `node company/tools/onboard.js --selftest` |
| `company/tools/owner-addressing.js` | ceo | `node company/tools/owner-addressing.js --selftest` |
| `company/tools/owner-inbox.js` | ceo | `node company/tools/owner-inbox.js --selftest` |
| `company/tools/pack.js` | ceo | `node company/tools/pack.js selftest` |
| `company/tools/providers.js` | ceo | `node company/tools/providers.js selftest` |
| `company/tools/quest-audit.js` | tools | `node company/tools/quest-audit.js --selftest` |
| `company/tools/restart-station-idle.sh` | tools | `bash company/tools/restart-station-idle.sh --selftest` |
| `company/tools/restart-station.js` | tools | `node company/tools/restart-station.js selftest` |
| `company/tools/retention.js` | tools | `node company/tools/retention.js selftest` |
| `company/tools/routine-rules.js` | tools | `node company/tools/routine-rules.js selftest` |
| `company/tools/station-seed.js` | ceo | `node company/tools/station-seed.js --selftest` |
| `company/tools/text-corruption.js` | finance | `node company/tools/text-corruption.js --selftest` |
| `company/tools/tool-inventory-check.js` | tools | `node company/tools/tool-inventory-check.js --selftest` |
| `company/tools/tool-parse.js` | tools | `node company/tools/tool-parse.js --selftest` |
| `company/tools/workspace-modes.sh` | risk | `bash company/tools/workspace-modes.sh --selftest` |

## 8. The handoff queue in due order

`node company/tools/handoff-status.js --due` prints every OPEN handoff, soonest deadline first, with `OVERDUE` /
`TODAY` flags. Write deadlines as `**Deadline:** YYYY-MM-DD HH:MM` (company timezone, `co.TZ`) on a line of their own,
prose after the date. Prose deadlines are left undated on purpose and sorted last, never dropped.

## 9. Failure playbook

| Failure | Action |
|---|---|
| Station down | Section 4 "Down". Report cause and fix to the CEO. |
| Skill install fails | Check health, read the jsonl entry, retry once, check the skill has a valid `SKILL.md`. Still failing: report the exact error and the agents affected. Never hand-copy files into agent state. |
| Agent missing a skill | `skills.js install <name> --agents <id>`, then `verify`; note why it was missing. |
| Token rotated | Update it only in `secrets/<name>`; restart the station if it reads it at startup; test the dependent tool; tell risk. A new token from the owner is an access gate. |
| A duty is broken or stale (an OPEN `duty <id> is broken/stale` handoff) | `node company/tools/duty-status.js`; run the tool's `--duty` by hand and read its exit code and output (docs/DUTIES.md §1). Broken: fix the tool (a reviewed change). Stale: the per-tick cap (`company/state/duties.json` `waits`), a halt, or the dispatcher not ticking. Set the handoff DONE when `duty-status.js` shows it ok. |
| StarNet update drops a patch | Re-run `scripts/setup-station.sh`; fix and re-record a patch that no longer applies. |

## 10. Weekly report to the CEO

Station uptime and restarts; verify result (agents × skills); inventory changes; cost movement; open risk and finance
items; rotation due dates; what was verified versus assumed.

**Escalate to the owner only for** money, access, ownership or commitment. Everything else tools decides and reports.
