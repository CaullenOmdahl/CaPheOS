# Capability packs

A **capability pack** adds one line of business to a company: a shorts studio, lead generation, later a paper
trading desk. The framework stays company-agnostic; a pack is how a company becomes good at a specific job without
anyone hand-wiring tools into `company/tools/`.

Tool: `company/tools/pack.js`. Schema: `company/schemas/pack.schema.json`. Scaffold: `packs/_template/`.

## 1. The rules

1. **Ship scaffolds, don't wire them.** A pack folder in `packs/` changes nothing by existing.
2. **Docs and standards are on.** Everything under a pack's `docs/` (and its README) is readable by every agent from
   the moment the folder exists, installed or not. Reading is never gated.
3. **Tools are ABSENT until install.** Nothing in a pack is callable before the owner installs it. A template ships
   no tool and no stub: `tools/` holds only a README. There is no "dormant callable" state; on install the listed
   files are copied to `company/tools/packs/<id>/`, on uninstall they are removed.
4. **Limits ship CLOSED.** Every limit file ships with every number `0` and every list empty, and holds no
   booleans. A limit is a quantity the owner opens, not a switch somebody flips back on. Closed means nothing can
   happen even if a tool runs.
5. **Meters are locked on install.** Files that measure the pack (reconcile records, P&L, a capital ledger,
   competence-style scoreboards) are registered with `locked-watch.js` the moment the pack is installed, so the
   seats that work the pack can never edit what grades them.
6. **A scaffold is a contract plus a FAILING conformance test, never a blank file.** The template's
   `conformance/test.js` fails and lists what is missing. A pack is filled when that test, extended with the pack's
   own checks, passes.
7. **Declared requirements, checked fail-closed.** `pack.json` `requires` names the other packs, guardrails,
   secrets, governance categories, external-gate categories and station abilities the pack needs. `pack doctor`
   fails on anything it cannot prove: an unreadable file, an unknown name, a missing secret all count as failure.
8. **Status is exactly one of `absent | dormant | conformant`.** Only `conformant` counts as capability. A company
   may not claim, plan around, or sell a line of business whose pack is not conformant.
9. **Agents fill, the owner installs.** Any seat may fill a scaffold and `propose` it. Approval follows
   `co.gate('packs')` (default `approve` in every preset). `install` and `uninstall` are owner-only at every level.

## 2. Pack layout

```
packs/<id>/
  pack.json              the manifest (schema below)
  README.md              the contract: what the pack does, seats, external acts + gates, limits, meters, halt
  docs/                  standards the seats follow (always readable)
  tools/                 README.md only in a template; the filled pack's tools, each listed in pack.json
  limits/                JSON caps, shipped closed
  roles/                 seat templates (charter starting points, same format as company/roles/templates/)
  routines/              routine definitions (JSON) the pack's seats run once wired
  panels/<panel-id>/     console panels (docs/CONSOLE-PANELS.md format)
  conformance/test.js    the conformance test; fails until the contract is met
```

`<id>` is lowercase, `^[a-z][a-z0-9-]{1,39}$`, equal to the folder name. A leading underscore (`_template`) marks
a template: never proposable, never installable.

## 3. pack.json

| Field | Meaning |
|---|---|
| `version` | `1` (format version) |
| `id`, `title`, `summary`, `packVersion` | identity; `packVersion` is semver |
| `template` | `true` only in a scaffold |
| `owner` | the function answerable for the pack (`ceo`, `people`, `tools`, `risk`, `floor`, `finance`) |
| `requires.packs` | packs that must be installed **and conformant** (cycles fail) |
| `requires.guardrails` | guardrails that must be ON (`co.guard`) |
| `requires.secrets` | `secrets/<name>` files that must exist and be non-empty; the content is never read |
| `requires.governance` | governance categories that must exist in `governance.json` |
| `requires.externalGates` | external-gate categories the pack's outside acts use (`message`, `publish`, `account`, `form`, `spend`, `network`) |
| `requires.stationAbilities` | names that must appear in `company/company.json` `station.abilities` (an array; missing = nothing) |
| `docs[]` | doc files; must exist |
| `tools[]` | `{file, purpose}`; files directly under `tools/`; nothing unlisted may sit there |
| `seats[]` | `{name, template, independentOf?, why}`: role templates (section 6) |
| `routines[]` | `{file, seat?, why}` |
| `panels[]` | panel folders |
| `limits[]` | `{file, owner, why}`; at least one; closed when shipped |
| `meters[]` | `{p, append?, writers?, owner, why}`; `p` under `company/work/packs/<id>/` |
| `allowlist[]` | `{host, why}`: external-gate `network` allowlist lines added on install |
| `conformance.test` | path of the conformance test |

## 4. Lifecycle: absent -> dormant -> conformant

| Status | Means |
|---|---|
| `absent` | no folder in `packs/`, no proposal, not installed |
| `dormant` | the folder exists (shipped, filled, proposed or approved) but is not installed; **or** it is installed and doctor fails (a tool missing or changed, a meter unregistered, a requirement broken, the conformance test failing) |
| `conformant` | installed, and every doctor check passes, conformance test included |

```
fill (any seat)       propose (any seat)          approve (gate 'packs')     install (owner)
packs/_template  ->  work folder  ->  company/state/packs/proposed/<id>  ->  approved (digest)  ->  installed
                                                                                                    |
                                                               uninstall (owner) <------------------+
```

- **propose `<dir>` --by `<seat>`** runs the static checks (schema, files, closed limits, no unlisted tool) and the
  conformance test, copies the folder to `company/state/packs/proposed/<id>/`, and asks the owner
  (`inbox.js ask`, about `packs`) with the summary, the requirements, a recommendation and the default (not
  installed). At `notify`/`auto` it tells the owner instead.
- **approve `<id>` --by `<owner>`** records the proposal's content digest in `company/state/packs.json`. At
  `approve` (the default everywhere) only the owner may approve; at `notify`/`auto` the CEO seat may, and `notify`
  tells the owner. `reject` is owner-only and deletes the proposal.
- **install `<id>` --by `<owner>`**, owner only, refuses unless the proposal is approved **with the same digest**
  (any edit after approval means approve again), every requirement holds and the conformance test passes. It then:
  copies the pack to `company/state/packs/installed/<id>/`; copies tools to `company/tools/packs/<id>/`; copies seat
  templates to `company/roles/templates/<id>--<seat>.md`; creates empty meter files; adds allowlist lines tagged
  `# pack:<id>`; registers meters, installed tools, installed limits and the installed `pack.json` in
  `company/state/locked-extra.json`; adds the pack's panels with `console-panel.js add --by owner`; tells the owner.
  Any failure rolls everything back.
- **uninstall `<id>` --by `<owner>`** removes the tools, seat templates, panels, allowlist lines and locked-watch
  registrations and the installed copy. **Meter records are kept** (a ledger is never deleted); they stop being
  watched. Hired seats are not released: that is `hire.js`, under the `release` gate.
- Owner commands are refused inside an agent's station run (`provenance.js underStation()`).

Every step is a row in `company/state/packs-log.jsonl`.

## 5. Doctor

```bash
node company/tools/pack.js list
node company/tools/pack.js status <id>
node company/tools/pack.js doctor --all          # every pack: ABSENT / DORMANT / CONFORMANT with findings
node company/tools/pack.js doctor <id>
node company/tools/pack.js doctor <dir>          # preview a working folder as if installed (for the seat filling it)
```

`doctor` exits 0 only when every **installed** pack is conformant. A shipped, uninstalled template is fine: it is
reported dormant and does not fail the run. `doctor <id>` on an absent id exits 1. The dispatcher or the risk seat's
sweep should run `doctor --all` daily and route a non-zero exit to the pack's owner function.

What doctor checks, all fail-closed: the schema; `id` = folder; listed files exist; `tools/` has nothing unlisted
(a template has nothing but its README); seat `independentOf` names real seats; shipped limits are closed; meters
live under `company/work/packs/<id>/`; the conformance test exists and passes; every `requires` entry holds; for an
installed pack, each installed tool is present and byte-identical to what install copied, each seat template is in
place, each meter is registered in `locked-extra.json`, each allowlist line is present.

## 6. What a pack adds

**Seats (role templates).** `seats[]` ship charter templates in `roles/`. Install places them as
`company/roles/templates/<id>--<seat>.md`, so `hire.js open ... --template <id>--<seat>` starts a charter from them.
Install never hires: hiring stays under the `hiring` gate. `independentOf` declares separation of duties (the seat
that reconciles is never the seat that trades); the pack's conformance test and `hire.js` should refuse one agent
holding both. (hire.js does not read `independentOf` yet; until it does, the pack's conformance test checks
`loops.json`.)

**Routines.** `routines[]` are definitions, not live clocks. After install the tools owner wires them through
`harness-change.js` (kind `schedule`, gate `schedules`), so a pack never adds a clock by itself.

**Panels.** `panels[]` are console panels in the `docs/CONSOLE-PANELS.md` format, added by the owner on install and
removed on uninstall. They may read the pack's meters only through sources allowlisted in `company/console/sources.json`.

**Limits.** Shipped closed. Installed copies live in `company/state/packs/installed/<id>/limits/` and are
locked-watched (owner: the limit's function). Opening a limit is an owner act: a `harness-change.js` of kind `policy`
reviewed by the limit's function and applied with the owner's approval. Pack tools must read their limits from the
installed copy and treat a missing or unreadable file as closed.

**External-gate allowlist entries.** `allowlist[]` hosts are appended to `company/state/external-allowlist.txt` (the
`network` category) with a `# pack:<id>` tag and removed on uninstall. Every other outside act a pack makes still goes
through `external-gate.js` with a clearance row in its category; a pack never gets a blanket clearance.

**Conformance tests.** `conformance/test.js` runs offline with `PACK_DIR`, `PACK_ROOT`, `PACK_INSTALLED` (`1|0`) and
`PACK_TOOLS_DIR`. It exits 0 only when the contract is met and prints `MISSING ...` lines otherwise. A filled pack
keeps the template's checks (no TODO left, tools listed and passing `--selftest`, limits present, at least one meter)
and adds its own (for example: a dry run produces a ledger row; a limit at zero blocks the act).

## 7. "Locked on install"

Install writes `company/state/locked-extra.json`:

```json
{ "_doc": "...", "entries": [
  { "p": "company/work/packs/<id>/ledger.jsonl", "cls": "A", "append": true, "writers": ["<tool>.js"], "owner": "finance", "area": "record", "why": "...", "pack": "<id>" },
  { "p": "company/tools/packs/<id>/<tool>.js", "cls": "F", "owner": "tools", "area": "tool", "why": "...", "pack": "<id>" },
  { "p": "company/state/packs/installed/<id>/limits/limits.json", "cls": "F", "owner": "finance", "area": "policy", "why": "...", "pack": "<id>" }
] }
```

Entries are in `locked-watch.js` MANIFEST shape. A meter with `writers` is class A: only those tools may write it,
anything else is put back. A meter without writers, the installed tools, limits and `pack.json` are class F: an
unrecorded change is reported to the owning function and the risk seat.

**locked-watch.js must be changed to honour this** (it has no external registration today): in `context()`, append
`readJson(P('company/state/locked-extra.json'), {}).entries` (only rows with a string `p` and `cls` in A/F/R) to
`MANIFEST`; and add `company/state/locked-extra.json` and `company/state/packs.json` to MANIFEST as class F,
writer `pack.js`, owner `risk`, area `policy`, so the registration file itself cannot be edited quietly. Until then
the registration is recorded but not enforced.

## 8. Governance

Category `packs` in `company/defaults/state/governance.json`, `approve` in every preset (`approve-everything`,
`gate-money-people`, `gate-money`, `autonomous`). The owner may set it lower with `governance.js set packs ...`; even
then only the owner installs. An unknown category or unreadable file reads as `approve` (co.gate fails closed).
See `company/DECISION_RIGHTS.md`.

## 9. Planned packs (sketches only)

**shorts-studio.** Turns company material (briefs, footage, scripts) into short vertical videos. Almost everything is
local: script, storyboard, edit, caption and render run on the station with local tools and station abilities
(`requires.stationAbilities` such as a local renderer). Seats: a producer and an independent reviewer who signs off
each cut against the pack's style standard in `docs/`. Exactly one external gate: the upload, through
`external-gate.js` category `publish` with a clearance row per video and the platform host on the pack allowlist.
Limits: uploads per day and render minutes per day, both shipped at 0. Meters: a publish ledger (what went out,
cleared by whom) and a review scoreboard, locked on install.

**leads-gen.** Finds and qualifies prospects for the company's own offer, writes the first contact, and hands warm
leads to the CEO. Research uses `network` to allowlisted data sources only; every outreach message is an
external-gate `message` act with a clearance row, and creating any account is `account`. Requires the
`externalActions` and `promptInjection` guardrails ON (scraped pages carry injection payloads). Limits: messages per
day, new contacts per day, data-source spend, all at 0. Meters: a contact ledger (append-only, who was contacted,
when, with which clearance), an opt-out list that tools must honour, and a reply-rate scoreboard, locked on install.

**trading (paper-only first).** A trading desk that starts on paper and stays there until the owner rules otherwise.
New guardrail `capitalCap` (ON by default; the pack requires it) bounds capital at risk, and a **daily-loss limit**
sits in the pack's limits, separate from the AI spend cap and the pacer: trading money and model money never share a
number. State: positions plus an **append-only capital ledger** (every fill, fee and mark), both meters locked on
install. Seats: a trading seat and an **independent reconcile seat** (`independentOf: ["trader"]`) that rebuilds
positions from the ledger and the venue statement every day and flags any difference; the reconcile seat's record is
a class-A meter the trader cannot write. Every order passes a **pre-trade risk check** (cap, daily loss, position
size, instrument allowlist, market open) before it leaves the tool. A **market calendar** in `docs/`/limits keeps
orders inside sessions. **Halt -> flatten:** a soft or hard halt (`co.halted()`) stops new orders and closes open
positions, then stops. Live trading is a later owner decision: a second pack version with venue secrets, the `spend`
external gate per order, and the limits still shipped at 0. Sketch only; no trading code ships.
