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
- Logs: the service's journal (`journalctl --user -u <unit> -n 200 --no-pager`).
- Restart: check health and for active runs first, restart, wait, re-check health. Tell the CEO if runs were cut off.
- **Down:** status, the last log lines, then the cause (port in use, bad env file, missing dependency, crash loop). Fix
  the one cause, restart once, re-check. A crash loop means stop restarting and read the logs.
- **Env file:** keep it at mode 0600 and never commit it.
- **Network bind:** binding beyond loopback (patch `0001`) exposes the API and UI to the network, and agents can run
  commands and write files. The bind and its host allowlist are a risk-reviewed setting. Revert by binding to
  `127.0.0.1` and restarting.
- **StarNet patches:** every change to StarNet's own code is a record in `company/patches/` (see its README).

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

**Rotation:** every credential has a rotation date in the inventory. Tools prepares; the rotation itself is a
risk-reviewed action, and creating or reissuing a credential is an owner gate. A credential rotated out of band
(exposure, loss) restarts its clock and is reported to risk at once.

## 6. Security and cost

- **Risk review triggers:** a tool that reads, stores or sends credentials; a new token; new network exposure; a change
  to the bind; a tool that executes remote input.
- **Finance triggers:** a new paid tool, plan upgrade, new provider, or a measurable usage increase.
- **Secrets:** read them only through `co.secret(name)` / `co.stationToken()`. Never print, log, paste or copy them into
  docs, handoffs or chat. If a secret appears in output, treat it as exposed and rotate it.

## 7. Checkers must be seen failing

A checker is not finished until someone else can see it refuse. Every gate, linter or guard in `company/tools/` has a
`--selftest` that builds a fixture and **fails** when the guard is removed, not one that merely passes. Its inventory
row names the command that passes and the mutant or fixture that shows it failing. Assert the *kind* of finding, not a
count: a count cannot tell a right failure from a wrong one.

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
| StarNet update drops a patch | Re-run `scripts/setup-station.sh`; fix and re-record a patch that no longer applies. |

## 10. Weekly report to the CEO

Station uptime and restarts; verify result (agents × skills); inventory changes; cost movement; open risk and finance
items; rotation due dates; what was verified versus assumed.

**Escalate to the owner only for** money, access, ownership or commitment. Everything else tools decides and reports.
