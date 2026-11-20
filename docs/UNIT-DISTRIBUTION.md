# Unit distribution: who gets which unit, where units come from, how they stay current

**Status:** owner decisions of 2026-11-20, to be built. "Skill" in conversation means a unit here: a versioned package
with a Cordis plugin (`docs/MODULE-SYSTEM.md`), which may provide skills, tools or both. Builds on the index format and
trust rules of `docs/MODULE-SYSTEM.md` sections 10 and 11; phase 0.5 (`docs/PORTING-UNITS.md`) is what runs today.

## The decisions

1. **Two audiences.** A unit is either **baseline** (every seat has it: how to ask the owner, the chain of command,
   refusal handling) or **assigned** (given to the seats whose work needs it: web pages, a market data reader, a
   design tool). Most units are assigned.
2. **Every seat can search every unit**: the ones installed in its company and the ones in the first-party repository,
   by name, summary and version, at no cost.
3. **A seat asks for what it needs.** It requests an assigned unit from its manager (its superior in the chain of
   command), or from the Founder. The manager or the Founder assigns a unit the company already has. Bringing a new
   unit into the company from the repository is the Founder's decision under the governance setting for add-ons
   (`packs`; when that setting is `approve`, the owner's).
4. **One first-party repository** of units, separate from the framework: one folder per unit, every version immutable
   and semver-tagged, and an index (`docs/MODULE-SYSTEM.md` section 10.1) published from it. Agents read that index to
   find units they can use and newer versions of the ones they have.
5. **New companies ship lean.** A new deployment carries only the units it needs to start: the baseline set and what
   its build profile asks for (`docs/FOUNDING.md`). Everything else is imported when a seat needs it.
6. **A service window checks for updates.** On a schedule, in a quiet window, the company reads the index, finds newer
   versions of its installed units, and applies them without anyone asking.

## How each piece works

### Audience and assignment

- `module.json` gains `audience`: `"baseline"` or `"assigned"` (default `"assigned"`).
- Assignments live in `company/state/unit-assignments.json`: `{ "<unit id>": { "seats": ["<seat id>", ...] } }`, each
  change recorded in the decisions log with who assigned it and why.
- `skills.js verify` and `reconcile` (and the dispatcher's 30-minute reconcile) expect, for each seat: every baseline
  unit's skills plus the skills of the units assigned to that seat, and remove an assigned skill a seat no longer has
  the assignment for. Until this lands, every enabled unit counts as baseline (today's behaviour).

### Search and request

- `unit.js search <words>` (and the agent tool `unit.search`): installed units and the configured indexes; each hit says
  whether the seat has it, whether the company has it, and its newest version.
- `unit.js request <id> --by <seat> --why "…"`: files one request to the seat's manager (chain of command), or the
  Founder when the seat has no manager or asks for a unit the company does not have yet. The answer assigns it,
  imports and assigns it, or declines with a reason. A declined request is not repeated within 7 days unless the
  reason changed (the same rule as owner questions).

### The first-party repository

- A separate Git repository; `units/<id>/` holds the source, tags `<id>@<version>` mark releases.
- CI on each tag: run the unit's conformance test, build the archive, record its digest, regenerate the index.
- Companies list it in `company/state/registries.json` as trusted (section 10.2). Third-party indexes stay untrusted by
  default.

### Lean founding

- The founding kit lists the baseline units and maps build-profile answers to the units they need; nothing else is
  installed. Units shipped inside the framework today move to the repository as they are ported.

### The service window

- A duty with a window in the company's quiet hours (default: daily, outside working hours), so an update never lands
  mid-run.
- Patch and minor versions: install, run conformance, enable, keep the previous version for rollback; a failed
  conformance or a crash after the update rolls back automatically (`docs/MODULE-SYSTEM.md` section 14).
- Major versions, new capabilities (network, files, secrets) or a licence change: a request to the Founder (or the
  owner under `packs: approve`) with what changes; never applied silently.
- One plain line to the owner per window that changed something; nothing when nothing changed.

## What exists and what is left

| Piece | Status |
|---|---|
| Units, the compat host, install and enable (`unit.js`) | built (phase 0.5) |
| Baseline skills on every seat, repaired every 30 min, certification gate | built (as "every company skill") |
| `audience` and assignments; reconcile honouring them | to build |
| `unit.js search` / `request` and the agent tools | to build (phase P3) |
| The first-party repository, its CI and index | to build |
| Lean founding kit | to build, with `docs/FOUNDING.md` |
| Service window for updates | to build |

Owner of the build: the platform team of the developing company. Order: audience and assignments, search and request,
the repository and index, the service window, then lean founding (it needs the repository).
