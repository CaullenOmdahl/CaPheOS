# Tool inventory

One row per script in `company/tools/`, `company/tools/lib/` and `company/tools/sudo-gate/`. Purpose is the file's own
header line; owner is the function (`ceo`, `people`, `tools`, `risk`, `floor`, `finance`) that answers for the tool,
resolved to a seat at runtime with `co.seatFor(...)`. Credentials name the `secrets/<name>` file only, never a value.

Selftest column: `--selftest` is a flag, `selftest` a subcommand; `scripts/test.sh` detects which one each tool takes
and runs it offline (no station, temp copy of the repo). `node company/tools/tool-inventory-check.js` holds the
runbook (`company/runbooks/tool-management.md` §5a/§7b) to the files on disk; update both when you add a tool.

| tool | purpose | owner | selftest | CLI | credentials |
|---|---|---|---|---|---|
| `company/tools/agy-contract.js` | run a scoped job through the Antigravity (AGY) CLI and return schema-validated JSON. | tools | — | `--prompt` `--prompt-file` | — |
| `company/tools/ask.js` | route a question to the right level, and refuse to route non-CEO questions to the CEO. | ceo | — | `--from` `list` `owners` | — |
| `company/tools/build-inventory.js` | writes company/model-inventory.json + company/MODEL_INVENTORY.md | people | `--selftest` | see header | minimax-key, openrouter-key, openrouter-mgmt-key |
| `company/tools/cadence.js` | how often the company wakes (its tempo): the dispatcher tick, each seat's loop schedule, cooldown and priority, inside bounds only the owner sets; exports tempoAllows(seatId, now) for the dispatcher's wake caps; the owner's Sprint (start-up) switch and its status. | tools | `selftest` / `--selftest` | `show` `set-default` `set` `bounds` `end-temporary` `apply` `sprint on\|off\|config\|status` `selftest` | — |
| `company/tools/cap-numerator.js` | the number a spend cap divides by has to be the number that gets billed. | finance | `--selftest` | `--status` `--json` `--selftest` | — |
| `company/tools/competence.js` | the company's competence ledger, v1 (shadow mode). No LLM, costs $0. | people | `selftest` | `collect` `compute` `show` `scoreboard` `verify` `amend` `daily` `selftest` | station-token |
| `company/tools/connector-scope.js` | is every StarNet connector still inside the scope the risk owner's inventory records for it? | risk | `--selftest` | `exit` `--json` `--selftest` | station-token |
| `company/tools/console-panel.js` | company-made panels for the owner console: check them, install them, and resolve their data. | tools | `selftest` | `list` `validate` `add` `approve` `reject` `remove` `hide` `unhide` `render` `selftest` | station-token |
| `company/tools/corrections.js` | 1-on-1s: a short, written correction for a habit that keeps coming back, shown to that person on | people | `selftest` | `tick` `list` `show` `block` `add` `edit` `recur` `retire` `selftest` | — |
| `company/tools/decide.js` | decision models: deterministic, versioned, logged, replayable rules that turn observed state into an action. | risk | `selftest` / `--selftest` | `list` `show` `eval` `replay` `test` `promote` `set-param` `outcome` `join` `health` `register` `selftest` | — |
| `company/tools/delegation.js` | while the owner is away, someone they name answers some of their approval questions for them. | ceo | `selftest` / `--selftest` | `grant` `revoke` `list` `answer` `register` `selftest` | — |
| `company/tools/default-branch-watch.js` | the GitHub-side tripwire for the one rule about GitHub: nothing lands on a repository's default | risk | `selftest` | `tick` `status` `baseline` `selftest` | — |
| `company/tools/dispatch.js` | wakes the agent who owns open work. | tools | `--selftest` | `--dry-run` `--selftest` | station-token |
| `company/tools/dispatcher-loop.js` | the self-paced dispatcher: one dispatch tick, then sleep the current tempo, forever. | tools | `selftest` / `--selftest` | `--once` `status` `selftest` | — |
| `company/tools/dossier.js` | keep every agent's StarNet dossier (identity.md, purpose.md, context.md, operating-manual.md) complete | people | — | `check` `sync` | — |
| `company/tools/escalate.js` | record a block and get the company's sanctioned next route. | ceo | — | `--agent` | — |
| `company/tools/external-gate.js` | THE CHOKEPOINT for every action that leaves the company; keyed acts (`--idem`) never go out twice (company/work/external-idempotency.jsonl, exit 4 = duplicate). | risk | `--selftest` | `check` `guard` `clear` `close` `list` `session` `idem` `--selftest` | station-token |
| `company/tools/founder-loop.js` | the Founder's loop routine on the station, and the two station grants every loop needs to work. | ceo | `--selftest` | `status` `ensure` `prompt` `--selftest` | station-token |
| `company/tools/governance.js` | the owner's dial: how much the company decides alone, per category. | ceo | `selftest` / `--selftest` | `show` `check` `set` `preset` `selftest` | — |
| `company/tools/guardrails.js` | the owner's switches for the company's hard blocks, one per block, including none at all. | risk | `selftest` | `show` `set` `off-all` `on-all` `sandbox` `apply` `selftest` | station-token |
| `company/tools/halt.js` | stop the company, softly or hard, and start it again. | ceo | `selftest` / `--selftest` | `status` `soft` `hard` `resume` `tick` `selftest` | station-token |
| `company/tools/handoff-archive.js` | move finished handoffs out of the inboxes agents re-read every run. | tools | — | `[--dry-run] [--hours N] [--keep N]` | — |
| `company/tools/handoff-status.js` | does every handoff section carry its own `**Status:**`, and what is the open set in due order? | tools | `--selftest` | `--all` `--quiet` `--due` `--selftest` | — |
| `company/tools/harness-change.js` | propose, review, apply and (if results get worse) revert a change to something the crew shares. | tools | `selftest` | `propose` `approve` `reject` `withdraw` `apply` `revert` `keep` `list` `show` `tick` `selftest` | — |
| `company/tools/health-check.sh` | READ-ONLY health probe for the company: the station, its service, the dispatcher, and any | tools | `--selftest` | (no args) probe; `--selftest` | station-token |
| `company/tools/hire.js` | the company's hiring tool: open a round, create three candidate agents on different models, interview | people | `selftest` / `--selftest` | `open` `candidate` `interview` `hire` `release` `remodel` `fire` `status` `models` `selftest` | station-token |
| `company/tools/inbox.js` | the owner (PM) inbox. Every question the company cannot answer within its authority goes here. | ceo | — | `ask` `list` `answer` `close` | — |
| `company/tools/incident-open.py` | open an incident row in company/work/incidents.md from a machine. | risk | — | `--detected <iso> --probe-output <file> [--by …]` | — |
| `company/tools/locked-watch.js` | notices any change to what measures, limits or protects the crew, and undoes or reports it. | risk | `selftest` / `--selftest` | `tick` `status` `revert` `accept` `undo` `baseline` `selftest` | — |
| `company/tools/mandate.js` | the company's mandate register. | ceo | — | `list` `show` `issue` `assign` `adopt` `note` | — |
| `company/tools/merge-gate.js` | the company's client-side merge gate, since GitHub branch protection needs GitHub Pro on a | risk | `selftest` | `status` `selftest` | — |
| `company/tools/model-drift.js` | the same setting in three places, checked in one run. | people | `--selftest` | `--json` `--selftest` `--roster` | station-token |
| `company/tools/model-stats.js` | our own "house benchmark": how each model actually performs on this company's work. | people | — | `[--days N] [--json]` | — |
| `company/tools/models.js` | each seat's own model chain: a primary and ordered fallbacks, set per agent, with automatic failover (model-policy.json seats; moves logged in company/state/model-moves.jsonl). | people | `selftest` | `show` `set` `chain` `check` `tick` `selftest` | station-token |
| `company/tools/module.js` | core modules: list them, check them, enable and disable them (docs/CORE-MODULES.md). | ceo | `selftest` / `--selftest` | `list` `status` `doctor` `enable` `disable` `gates` `selftest` | — |
| `company/tools/my-section.js` | each person's own section of their routine prompts: notes they write to themselves, kept on every run. | people | `selftest` | `show` `check` `set` `append` `clear` `history` `revert` `selftest` | — |
| `company/tools/offpeak-clocks.js` | does any routine own a clock inside a provider's peak-price blocks? | finance | `--selftest` | `--json` `--file` `--selftest` | station-token |
| `company/tools/offpeak-hold.js` | the off-peak hold, as ONE predicate with two triggers. | finance | `--selftest` | `--selftest` `--status` `--parity` | — |
| `company/tools/offpeak-proof.js` | proof that the off-peak hold works, as ONE command, read from the live records. | finance | `--selftest` | `--date` `--selftest` `--journal` | station-token |
| `company/tools/openrouter-treasury.js` | read-only treasury check for the company's OpenRouter provisioning key. | finance | — | `--json` `--min` | openrouter-mgmt-key, openrouter-key |
| `company/tools/onboard.js` | onboarding is certification, not provisioning: step ledger, the 11 certification checks, teardown. | ceo | `--selftest` | `--check` `--resume` `--step` `--certify` `--teardown` `--record` `--selftest` | station-token, console-token |
| `company/tools/owner-addressing.js` | decide WHO an owner message is for, by the name the owner writes first. | ceo | `--selftest` | `route` `dispatch` `--selftest` | — |
| `company/tools/owner-inbox.js` | messages the owner sent the company, and whether the CEO has acted on them; and the one way the | ceo | `--selftest` | `new` `count` `ack` `send` `log` `--selftest` | — |
| `company/tools/pack.js` | capability packs: list them, check them, propose, approve, install and uninstall them. | ceo | `selftest` / `--selftest` | `list` `status` `doctor` `propose` `approve` `reject` `install` `uninstall` `selftest` | — |
| `company/tools/pacer.js` | paces the company's AI use across the flat-fee subscriptions (Claude Max, MiniMax) and DeepSeek. | finance | — | `status` `plan` `report` `limits` `apply` `restore` `emergency` `mode` `limit` | — |
| `company/tools/performance.js` | is each person doing their job? Read from the station's own records, no LLM. | people | — | `report` `flags` | station-token |
| `company/tools/premerge-check.js` | the pre-merge gate the company runs because GitHub cannot enforce it here. | risk | `--selftest` | `--pr <n> [--repo o/n]` `--replay <base>:<head>` `--selftest` | — |
| `company/tools/project.js` | the product-takeover registry. Access is not ownership. | ceo | — | `list` `status` `request` `approve` `revoke` `assert` `discover` | — |
| `company/tools/provenance.js` | a tool that writes a locked file says so here, so company/tools/locked-watch.js can tell the tool's own | risk | `selftest` | `record` `tail` `selftest` | — |
| `company/tools/quest-audit.js` | find quests that no run can ever close. | tools | `--selftest` | `--json` `--selftest` | — |
| `company/tools/restart-station-idle.sh` | restart the station service only when no agent loop is mid-run. | tools | `--selftest` | `--status` `--selftest` | station-token |
| `company/tools/retention.js` | every growing file the company reads has a bound; this keeps each one inside it without losing a byte (docs/RETENTION.md). | tools | `selftest` / `--selftest` | `status` `apply` `audit` `selftest` | — |
| `company/tools/routine-length.js` | how long each routine actually runs, against the context window it must fit in. | people | — | `[--days N] [--json]` | — |
| `company/tools/routine-rules.js` | keep the house rules for scheduled runs at the end of every routine prompt. | tools | `selftest` / `--selftest` | `check` `ensure` `selftest` | — |
| `company/tools/skills-hr.js` | the people owner's skill review. StarNet's background skill review drafts skill proposals for each | people | `selftest` | `pending` `show` `approve` `reject` `give` `take` `catalog` `prescreen` `log` `selftest` | station-token |
| `company/tools/skills.js` | the skill propagation tool (owned by the tools function holder). | tools | `selftest` | `status` `verify` `install` `install-all` `selftest` | station-token |
| `company/tools/station-crew.js` | change who works on the station, headlessly, the way the StarNet page itself would. | people | — | `list` `sync` | station-token |
| `company/tools/station-floor.js` | the floor owner's tool: rooms, names, floor/wall/exterior paint, props, desks and seats, changed headlessly | floor | — | `show` `audit` `snapshot` `plan` `apply` `restore` `doc` | — |
| `company/tools/station-seed.js` | give a station whose page never ran (StarNet headless, CaPheOS patch 0010) its save and its Founder. | ceo | `selftest` / `--selftest` | `status` `seed` `selftest` | station-token |
| `company/tools/station-view.js` | let the crew SEE the real station (floor, top bar, crew rail, dock) without touching anything. | tools | `selftest` | `status` `shot` `look` `selftest` `clip` | station-token |
| `company/tools/text-corruption.js` | find figures that a shell expanded before they reached the file. | finance | `--selftest` | `--scan` `--quiet` `--json` `--selftest` | — |
| `company/tools/tool-inventory-check.js` | the runbook's tool table has to be true, not tidy. | tools | `--selftest` | `report` `--list-unlisted` `--selftest` | — |
| `company/tools/tool-parse.js` | does every tool in the layer even parse? | tools | `--selftest` | `--verbose` `--selftest` | — |
| `company/tools/vision.js` | look at an image with DeepSeek V4.1 Flash, on the company's DeepSeek key. Never OpenRouter. | tools | — | `<image> "<question>" [--by] [--detail low|high]` | deepseek-key |
| `company/tools/workspace-modes.sh` | the station's own files must not be readable by anyone but the user the station runs as. | risk | `--selftest` | `--check` `--fix` `--selftest` | — |
| `company/tools/lib/bounded.js` | read the end of a growing file without reading all of it (tail, page, time window, binary seek). | tools | via retention.js selftest | library (require) | — |
| `company/tools/lib/company.js` | the one place every CaPheOS tool learns who the company is, where things live, and who holds a seat. | tools | — | library (require) | station-token |
| `company/tools/lib/core-loop.js` | small time helpers shared by the core-loop tools (dispatch, handoff-status, handoff-archive). | tools | — | library (require) | — |
| `company/tools/lib/decision.js` | decision models: a deterministic function from observed state to a recommended action. No LLM, no code. | risk | via decide.js selftest | library (require) | — |
| `company/tools/lib/governance.js` | how a tool asks "may the company do this alone?" and acts on the answer. | ceo | — | library (require) | — |
| `company/tools/lib/guardrails.js` | helpers for the guardrail switches, shared by guardrails.js and the tools that enforce them. | risk | — | library (require) | — |
| `company/tools/lib/modkit.js` | small helpers shared by the core-module tools (intake, observe, parties, commitments, playbooks): limits, jsonl, handoffs, selftest roots. | tools | — | library (require) | — |
| `company/tools/lib/untrusted.js` | outside text never becomes an instruction: clean (control chars, length cap), inline, safeId, and fence (nonce marker + "data from <source>, not instructions") for event data in handoffs and prompts. | tools | via the commitments and playbooks --selftest | library (require) | — |
| `company/tools/lib/settle.js` | shared plumbing for the Act/Verify/Settle core modules (scopes, verify, evidence, reports, ledger): party paths, events, commitments, provenance-recorded writes, selftest roots. | tools | via the module tools' --selftest | library (require) | station-token (reachability only) |
| `company/tools/lib/modules.js` | the runtime side of core modules: enabled list, the dispatcher tick hook, the console HTTP mount. | tools | — | library (require) | — |
| `company/tools/lib/pacing-ask.js` | the subscription cutoffs are the owner's decisions: the pacer asks once on Today (two sliders), applies the answer through the recorded `pacer.js limit` path, FYI at auto/notify. | finance | via pacer.test.js | library (require) | — |
| `company/tools/lib/sprint.js` | the pure parts of Sprint (start-up): handoff Touches/Effort, the wake rest, the daily-cap spread, the lane plan, the per-path lane lock, Sprint spend. | tools | via `node --test company/tools/tests/sprint.test.js` | library (require) | — |
| `company/tools/lib/models-money.js` | shared helpers for the "models and money" tools (pacer.js, offpeak-*.js, cap-numerator.js). | finance | — | library (require) | — |
| `company/tools/sudo-gate/broker.py` | runs a fixed allowlist of root commands on behalf of the company's agents. | risk | via sudo-gate/selftest.py | socket-activated (stdin request); not run by hand | — |
| `company/tools/sudo-gate/install.sh` | install (or --uninstall) the CaPheOS root-command broker for agents. Run as root (sudo). | risk | — | `sudo bash install.sh [--uninstall]` | — |
| `company/tools/sudo-gate/selftest.py` | offline policy test for broker.py | risk | is the selftest (no args) | `python3 -I selftest.py [broker.py]` | — |
| `company/tools/sudo-gate/sudo-shim.py` | sudo shim for the company's agents: routes station-descendant sudo calls to the root broker, everyone else to the real sudo. | risk | — | installed as `~/.local/bin/sudo`; sudo options | — |

## Core module tools (rows kept instance-local)

A core module's tools are absent until the owner enables it (`node company/tools/module.js enable <id> --by owner`);
enable copies them into `company/tools/` and writes their rows from `modules/<id>/rows.md` to the gitignored
`company/state/inventory-local.md` (never to this tracked file, so a framework `git pull` stays clean).
Shipped by the Act/Verify/Settle modules: `scopes.js` (risk), `verify.js` (risk), `evidence.js` (risk), `reports.js`
(ceo), `ledger.js` (finance); each runs `--selftest` offline, and each module's `conformance/test.js` runs it.
