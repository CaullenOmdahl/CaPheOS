# Portable modules — design specification

**Status:** v0.1 draft for review. Nothing here is implemented yet.
**Supersedes:** the packaging and distribution parts of `docs/PACKS-SPEC.md` (v1 packs keep working; see §13).
**Related:** `docs/CORE-MODULES.md` (framework-shipped modules), `docs/BUDGET.md`, `docs/MEETINGS.md`, `docs/CONNECTORS.md`, `company/schemas/pack.schema.json`.

---

## 1. Why this exists

Today a capability only exists inside a company checkout. A tool written in `company/tools/`, a seat template, a panel, a routine — each is a file wired to this company's paths, names and secrets. The consequences are structural:

- the capability cannot leave the company;
- it cannot be reused by another company;
- it cannot be published, versioned or reviewed as a product;
- and if the company is wound down, none of it survives.

This specification changes the unit of value from **the environment** to **the module**: a versioned, self-describing, individually installable and exportable package. A company becomes a governed composition of modules.

**One-sentence rule for the whole document:**

> A module is a product. The company is a composition. The governance is what makes the composition safe.

---

## 2. Terms

One noun per thing. Do not introduce synonyms.

| Term | Meaning |
|---|---|
| **Core module** | A generic business layer shipped with CaPheOS (`modules/`, see `docs/CORE-MODULES.md`). Not installable, versioned with the framework, read-only. |
| **Module** | A portable unit governed by this spec: manifest + files + conformance test, installable into any company. |
| **Module kind** | One of `capability`, `workflow`, `seat`, `surface`, `stack`. |
| **Stack** | A module that composes other modules and company policy (formerly a *pack*). A vertical: "content studio", "leads desk", "overnight NOC". |
| **Manifest** | `module.json` at the module root. The only file every consumer reads. |
| **Conformance** | The module's own test proving it meets its contract. A module is not capability until it conforms. |
| **Registry** | A named source of an **index** (a JSON list of modules). |
| **Index** | A published list of module entries: id, version, kind, source, digest, engine requirements, publisher. |
| **Install** | Fetch a pinned module into the company's unit store, verify its digest, record provenance. Installed code is inert. |
| **Enable** | Make an installed module's contributions active for the company (tools callable, seat hirable, surface shown). |
| **Export** | Produce a portable archive of a module instance — manifest, files, config schema, lockfile, conformance, provenance. Never company memory. |
| **Import** | Install + configure a module from an archive or a registry. |
| **Capability (of a module)** | A declared permission the module needs: network hosts, filesystem roots, secret names, subprocess, environment. |
| **Parameterization** | The rule that a module may not name its company; everything company-specific arrives as configuration. |

---

## 3. Principles

**P1 — The module is the unit of value.** Every capability that can be a module is one. A module outlives the company, the instance and the host.

**P2 — A module that names the company cannot leave it.** No company name, owner, port, path, timezone, currency, seat name or secret value is baked into a module. All of it is config, and secrets are referenced by name only. The conformance test fails a module that violates this.

**P3 — Docs read, code inert, limits closed, meters locked.** Inherited from `PACKS-SPEC` and binding here:
- documentation is readable whether or not the module is enabled;
- module code is not callable until enabled;
- limit files ship closed (every number `0`, every list empty, no booleans);
- meter files are registered with `locked-watch` at enable time.

**P4 — No ambient authority.** A module declares its capabilities in the manifest; the host grants them through one capability broker. A module that needs the network says so; one that does not gets no network. Undeclared access fails closed.

**P5 — Governance is CaPheOS's layer.** Install, update, enable, disable, export and registry changes are governed acts: reviewed, approved, recorded in the decisions log, revocable. This is the difference between a plugin directory and a company operating system.

**P6 — Compose, don't fork.** The packaging shape and host interfaces are DSH-compatible (§12) so the existing plugin ecosystem can be consumed; integrations use MCP, the open standard, so they run in other hosts too.

**P7 — Absence is not capability.** A module's state is exactly one of `absent | fetched | dormant | configured | conformant | enabled | disabled | broken`. Only `conformant + enabled` counts as capability. A company may not claim, plan around, or sell a line of business whose stack is not conformant.

**P8 — One manifest, one lifecycle, one installer.** No parallel installation paths. `company/tools/unit.js` is the only installer; everything else reads `company/state/units.json`.

---

## 4. Architecture

```
┌───────────────────────────── Host (DSH-compatible composition) ─────────────────────────────┐
│ Cordis (MIT) · CaPheOS services · module loader · MCP client                                  │
└───────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                        │
┌───────────────────────────────────────▼─────────────────────────────────────────────────────┐
│ CaPheOS company layer  (this repo)                                                          │
│ company (config) · seats/functions · dispatcher · budgets · approvals · decisions · ledger  │
│ unit system:  manifest → capability broker → lifecycle → registry → export/import           │
│ core modules: intake · observe · parties · commitments · playbooks · scopes · verify ·      │
│               evidence · reports · ledger · liveness · continuity                           │
└───────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                        │
┌───────────────────────────────────────▼─────────────────────────────────────────────────────┐
│ Module kinds                                                                                │
│ capability (host plugin | MCP server | CLI tool) · workflow · seat · surface · stack         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Composition, not ownership

CaPheOS owns its host, but **Cordis (MIT) is the plugin substrate** — the extension standard, not DSH's backend. No `@deepseek-ai/dsh-*` package is a dependency. The owner interface is CaPheOS's own console; the company layer is CaPheOS's own code; every host capability is a Cordis plugin providing a CaPheOS service. DSH-specific plugins are reached through the interop levels in §12.1. The unit system sits between the host and the modules: it validates, installs, brokers and records.

### 4.2 Directory layout

| Path | Content | Rules |
|---|---|---|
| `modules/` | framework core modules | read-only, part of the framework |
| `packs/` | module **sources** and scaffolds (authoring location) | changes nothing by existing |
| `company/state/units/<id>/<version>/` | installed module files | immutable; only `unit.js` writes |
| `company/state/units.json` | installed/enabled state, digests, approvals | tier-3, tool-written |
| `company/state/registries.json` | known registries and indexes | tier-3, owner-only changes |
| `company/work/units/<id>/` | module runtime data and config values | module-scoped; meters locked if declared |
| `company/work/units/<id>/config.json` | the company's configuration values | tier-2; never exported |
| `company/tools/unit.js` | the installer/inspector/export tool | the only writer of the unit store |

Legacy `company/tools/packs/<id>/` remains readable during migration; §13 defines the mapping.

---

## 5. Manifest — `module.json`

### 5.0 Plugin contract

A module's executable form is a **Cordis plugin**: `apply(ctx, config)`, receiving a context and a validated config. Cordis supplies the lifecycle, service injection, events, per-plugin config schema and disposal. CaPheOS supplies the services modules consume (§5.7.2) — the named seam over what this repo already does — and the capability broker that gates them. A module declares the services it needs; a service it does not declare is absent at load, not denied at call time.

`module.json` at the module root. JSON Schema: `company/schemas/module.schema.json` (to be written alongside this spec).

### 5.1 Common fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | integer | yes | `2` for this spec |
| `id` | string | yes | `^[a-z][a-z0-9-]{1,39}$`; equals the folder name; globally unique per registry |
| `version` | string | yes | semver; a version is immutable once published |
| `kind` | enum | yes | `capability \| workflow \| seat \| surface \| stack` |
| `title`, `summary` | string | yes | display; summary ≤ 600 chars |
| `author`, `license`, `homepage` | string | license yes | `license` must be an SPDX identifier or `SEE LICENSE IN <file>` |
| `engines` | object | yes | `{ "caPheOS": ">=x", "dsh": ">=y"?, "node": ">=z"? }` |
| `requires` | object | yes | see §5.3 |
| `capabilities` | object | yes | see §5.4; `{}` means none |
| `config` | object | no | JSON Schema for company configuration + `defaults` |
| `provides` | object | yes | what the module contributes: `tools[]`, `seats[]`, `workflows[]`, `surfaces[]`, `stacks[]`, `mcpServers[]` |
| `docs` | array | yes | documentation files; readable whether enabled or not |
| `limits`, `meters` | array | kind-dependent | same semantics as `pack.json` |
| `allowlist` | array | no | network hosts the module needs (declared capability, added on enable) |
| `conformance` | object | yes | `{ "test": "conformance/test.js" }` |
| `provenance` | object | published only | `{ source, commit, digest, publishedAt, publisher }` |
| `dsh` | object | no | DSH compatibility block (§12) |
| `mcp` | object | no | MCP server descriptor (§12) |

### 5.2 Kind-specific fields

- **capability:** `entry` (host plugin path or MCP server descriptor or CLI path), `secrets[]`, `network[]`, `fs[]`.
- **workflow:** `routines[]` (`{file, seat?}`), `playbooks[]`, `clocks[]`.
- **seat:** `role` (role template path), `skills[]`, `modelPolicy` (declaration, not values), `permissions` (declaration), `routines[]`.
- **surface:** `panels[]` (CaPheOS console-panel format, `docs/CONSOLE-PANELS.md`). DSH client plugins are not a supported surface on this host (§12.1).
- **stack:** `composes[]` (module ids + version ranges), `policies[]` (policy templates), `none` of its own code required.

### 5.3 `requires`

Same shape as the v1 pack (packs, coreModules, guardrails, secrets, governance, externalGates, abilities) plus:

| Field | Meaning |
|---|---|
| `modules[]` | module ids (with optional version range) that must be `conformant + enabled` |
| `mcpServers[]` | MCP servers that must be present and healthy |
| `hostPackages[]` | host packages the module compiles against (declared, version-checked) |

Resolution rules: cycles fail; a missing requirement fails closed; an unreadable requirement fails closed.

### 5.4 `capabilities`

```json
"capabilities": {
  "network": ["api.example.com"],
  "fs": { "read": ["company/work/units/<id>/**"], "write": ["company/work/units/<id>/**"], "refuse": ["secrets/**", "company/state/locked/**"] },
  "secrets": ["example-api-key"],
  "subprocess": false,
  "env": []
}
```

The broker grants exactly this at enable time. `secrets` names are resolved through the secrets layer; values never enter the module's files, logs or exports.

### 5.5 Example — a capability module

```json
{
  "format": 2,
  "id": "health-ping",
  "version": "1.0.0",
  "kind": "capability",
  "title": "Health ping",
  "summary": "Probe a URL on a schedule and emit an intake event when it is down.",
  "author": "Example",
  "license": "MIT",
  "engines": { "caPheOS": ">=0.2", "node": ">=22" },
  "requires": { "coreModules": ["observe", "intake"], "guardrails": ["externalActions"] },
  "capabilities": {
    "network": ["api.example.com"],
    "fs": { "read": ["company/work/units/health-ping/**"], "write": ["company/work/units/health-ping/**"] },
    "secrets": [],
    "subprocess": false
  },
  "config": {
    "schema": { "type": "object", "required": ["target"], "properties": { "target": { "type": "string", "format": "uri" }, "everyMin": { "type": "integer", "minimum": 1, "default": 5 } } },
    "defaults": { "everyMin": 5 }
  },
  "provides": { "tools": [{ "name": "health_ping.check", "file": "tools/check.js", "purpose": "probe once" }] },
  "docs": ["README.md"],
  "limits": [{ "file": "limits/ping.json", "owner": "risk", "why": "caps probes and timeouts" }],
  "conformance": { "test": "conformance/test.js" }
}
```

### 5.6 Example — a seat module

```json
{
  "format": 2,
  "id": "research-analyst",
  "version": "1.0.0",
  "kind": "seat",
  "title": "Research analyst",
  "summary": "A careful analyst seat: sources everything, states confidence, files findings.",
  "license": "MIT",
  "engines": { "caPheOS": ">=0.2" },
  "requires": { "modules": ["web-research@^1"], "governance": ["hiring"] },
  "capabilities": { "network": [], "fs": { "read": ["company/work/**"] }, "secrets": [], "subprocess": false },
  "provides": {
    "seats": [{ "name": "analyst", "role": "roles/analyst.md" }],
    "workflows": [{ "file": "workflows/daily-brief.json", "seat": "analyst" }]
  },
  "docs": ["README.md", "docs/standards.md"],
  "limits": [{ "file": "limits/tokens.json", "owner": "finance", "why": "bounded daily work" }],
  "conformance": { "test": "conformance/test.js" }
}
```

A seat module ships **configuration**: role charter, persona, skills, model-policy declaration, permission declaration, routines. It ships **no memory, no competence record, no credentials and no company history**.

### 5.7 The service surface — the `ctx` a module sees

A module's code is a Cordis plugin: `apply(ctx, config)`. Everything it may touch is a service on `ctx`. A name not listed here is **absent**, and the manifest's `capabilities` decide whether the broker grants it. The names and signatures below are the contract, versioned with `engines.caPheOS`.

The point of this section: **"our existing plugins written to a proper standard" has a concrete meaning** — every tool, tick, route, panel and role becomes one of the shapes in §5.7.4, against the services in §5.7.2. Nothing else changes behaviour.

#### 5.7.1 From the framework (Cordis, MIT — 4.0.0-rc.13)

| Facet | What a module gets |
|---|---|
| `apply(ctx, config)` | the entry; `config` is validated against the module's `config.schema` before `apply` runs |
| `export const inject = [...]` | services that must exist before `apply` runs; a missing one keeps the module `dormant`, it is never a runtime surprise |
| `ctx.effect(fn)` | register a resource; `fn` returns its disposer; disposal runs on disable and on uninstall |
| `ctx.on(event, fn)` | listen; the broker limits which events a module may hear |
| `ctx.get(name)` | read an optional service without declaring it |
| `ctx.logger` | the module's own logger — never the console's stdout |
| `export const Config` | optional row-config schema; in CaPheOS the `module.json` `config` block is the source of truth and `Config` is derived from it |
| disposal | every resource is released through `ctx.effect`; a module never registers a `process.on` cleanup |

#### 5.7.2 CaPheOS services

These are the services the host provides to modules. "Today" names the mechanism that already exists in this repo; the service is the named seam over it.

| Service | Today | Minimum methods | Used by |
|---|---|---|---|
| `company` | `lib/company.js` | `root()`, `config()`, `path(...)`, `tz()`, `halted()` | every module |
| `secrets` | `co.secret(name)` | `get(name)` — value handed to the broker, never logged or exported | modules with a `secrets[]` capability |
| `seats` | `loops.json`, `co.crew/seatFor/ceo/nameOf` | `list()`, `byFunction(fn)`, `ceo()`, `nameOf(id)`, `resolve(idOrFn)` | work, panels, meetings, duties |
| `agents` | the station's run loop (StarNet today) | `run(seat, {purpose, task, tools})`, `stream(runId)`, `list()` | duties, workflows, surfaces |
| `work` | dispatcher, duties, handoffs | `appendHandoff(seat, heading, fields)`, `open(owner)`, `due()` | modules, seats |
| `money` | `budget.js`, `money-hold.js`, provider balance | `cap(scope)`, `reserve(cost)`, `record(usage)` | anything that spends |
| `approvals` | `approvals.js`, owner questions | `ask(question, options)`, `answered(id)` | anything gated |
| `governance` | `co.gate`, `co.governance`, `decision.js` | `gate(id, request)`, `record(decision)` | lifecycle acts |
| `guardrails` | `co.guard`, `guardrails.js` | `check(kind, payload)` | external actions |
| `intake` | `modules/intake` | `emit(event)`, `on(type, fn)`, `read()` | the sense layer |
| `tools` | `company/tools` registry, INVENTORY.md | `register(tool)`, `get(name)`, `list()`, `execute(name, args)`; emits `tools/result` | capability modules |
| `limits` | `modkit.limits/limit` | `get(id, key)` — **closed by default**, opened only by the owner | every module |
| `meters` | `locked-watch` | `declare(path)`, `append(row)` | spend and metrics |
| `store` | `modkit.readJsonl/appendJsonl/writeJson` | `read(path)`, `append(path, row)`, `write(path, obj)` — jailed to `company/work/units/<id>/` | every module |
| `skills` | `company/skills` (8 `SKILL.md` packs) | `list()`, `load(name)` | seats; same name as the DSH service (§12.1.1) |
| `panels` | `console-panel.js`, `docs/CONSOLE-PANELS.md` | `register(panel.json)` | surface modules |
| `http` | `console/server.js` routes (`/api/…`, `/hooks/…`) | `register({method, path, auth, handler})` | modules with endpoints |
| `units` | `module.js` today, `unit.js` in this spec | `list()`, `state(id)`, `isEnabled(id)`; install/export only for the owner's unit tools | stacks, inspection |

Two names are deliberately shared with the DSH ecosystem (`skills`, and `agents` as the run seam) so an imported host plugin lands on an existing service instead of a new one.

#### 5.7.3 Rules

- **R1 — Declare, never reach.** A module that calls `require('fs')`, `fetch` or `child_process` directly fails conformance unless its manifest declares that capability; services are the sanctioned path, and the broker enforces it.
- **R2 — Names are the ABI.** Adding a method is a minor version; changing or removing one is a major version of `engines.caPheOS`. A module declares the services it compiles against.
- **R3 — Granted at enable, not at call.** The broker decides per grant when the module is enabled; `secrets.get` resolves declared names only.
- **R4 — Tools have a dual shape.** Functions first, CLI second, plugin third (§5.7.4) — so a seat, a selftest, a duty and a model tool all call the same code.
- **R5 — A small event set.** The host emits `tools/result`, `run/end`, `intake/event`, `dispatch/tick`, `approval/decided`, `units/changed`. A module listens only to the events its capabilities include; modules do not emit host events, they call services.

#### 5.7.4 From today's files to the standard shape

| Today | Portable shape | Behaviour kept |
|---|---|---|
| `company/tools/<name>.js` (CLI, `--selftest`, `--json`, module exports) | capability module: `tools/<name>.js` exports the functions; `tools/<name>.cli.js` keeps the CLI; `host/plugin.js` registers the tools on `ctx.tools` via `ctx.effect`; `module.json.provides.tools` | identical commands, exit codes and JSON; the model-facing tool is the in-process registration |
| `modules/<id>/tick.js` (`{ tick, runWhenHalted, timeoutMs }`) | `host/plugin.js` with `ctx.effect` and `ctx.work.every(min, fn)`; the dispatcher owns the clock | halted-company skip, timeout, failure isolation |
| `modules/<id>/http.js` (`{ routes: [...] }`) | `host/plugin.js` calls `ctx.http.register(...)`; `auth: 'owner' \| 'source'` kept | same paths and auth |
| `modules/<id>/panels/<panel>/` | surface module: `surfaces/panels/<id>/panel.json`, unchanged contract | the panel spec and `sources.json` allowlist |
| `modules/<id>/limits/*.json` | unchanged files; the broker opens them through `limits` | shipped closed |
| `company/skills/<name>/SKILL.md` | unchanged files; a seat module lists them in `provides.skills` | skills are files, not code |
| `roles/`, routines | seat module: `roles/<role>.md`, `workflows/*.json` | charter, persona, routines |

This is the whole rewrite: **same functions, one shape**. A tool that is ported does not change what it does — it gains a manifest, a service seam, a conformance test and a version.

---

## 6. Package layout

```
<module>/
  module.json            the manifest
  README.md              the contract: what it does, what it needs, what it may touch, how to remove it
  docs/                  standards and how-to, readable unenabled
  host/                  optional Node host plugin (DSH/Cordis-compatible entry)
  client/                optional client plugin (surfaces/slots)
  mcp/                   optional MCP server (stdio or http descriptor)
  tools/                 callable tools (capability kind)
  roles/                 role templates (seat kind)
  workflows/             routine/playbook definitions
  surfaces/              console panels
  limits/                closed limit files
  meters/                declarations only (paths are company-side)
  conformance/test.js    fails until the contract is met
  locale/                optional translations
  icon.svg               optional display icon
  LICENSE, NOTICE        attribution, especially for vendored code
```

Nothing outside the manifest's `provides` may be callable. Files not listed are inert data.

---

## 7. Lifecycle

```
discover → add-source → inspect → install → dormant → configure → conformance → enabled
                                                         ↘ broken (quarantined)
enabled → disable → enabled          enabled → update → dormant → conformant → enabled
enabled → export → archive           enabled → uninstall → removed (data kept or purged)
```

| State | Meaning | Transition gates |
|---|---|---|
| `absent` | not known to the company | — |
| `fetched` | source added; not installed | registry approval |
| `dormant` | installed, code inert | install approval + digest verification |
| `configured` | company config validates against the module's schema | config write (gate `packs`) |
| `conformant` | the conformance test passed at this version + config | conformance |
| `enabled` | contributions are active | enable approval + broker grant |
| `disabled` | installed, inert, data intact | disable |
| `broken` | failed conformance after an update, or crashed repeatedly | update/rollback |

**Uninstall** removes the installed files and disables the contributions; it keeps `company/work/units/<id>/` unless purged, and records the removal. **Export** is available from any installed state.

---

## 8. Governance

Every lifecycle transition is a governed act, recorded in `company/work/decisions.md` and `company/state/units.json` with the approver, surface and digest.

| Act | Gate | Approver |
|---|---|---|
| Add a registry/index | `trust` | owner |
| Install a module | `packs` | owner (CEO may propose) |
| Install from a **new** publisher | `packs` + `risk` review | owner |
| Update a module | `packs` | owner |
| Enable / disable | `packs` | owner (a seat may propose) |
| Export | `packs` | owner |
| Uninstall | `packs` | owner |

**Capability broker.** On enable, the host grants the manifest's declared capabilities only. Enforcement points: the tool registry (capability gate, as today), the network layer (host allowlist), the filesystem layer (module root + declared roots), the secrets layer (named access), and the subprocess layer (off by default). Undeclared access fails closed.

**Meters are locked** on enable: any path the module declares as a meter is registered with `locked-watch` and cannot be edited by the seats it measures.

**Revocation.** Disable is one click; it detaches the contributions, revokes broker grants, keeps data. Uninstall removes the files. A broken update falls back to the last conformant version automatically.

---

## 9. Export and import

### 9.1 What an export contains

- `module.json` with the **pinned** version and full `provenance`;
- the module files;
- the config **schema** and defaults — **never config values**;
- a lockfile of resolved dependencies (modules, core modules, host packages, MCP servers);
- the conformance test and its last passing result;
- licence notices.

**Never included:** company name/owner/paths/ports, secret values, company memory, decisions, ledger, competence records, client data, `company/work/units/<id>/` data unless the module explicitly declares an `exportData` schema and the owner approves it.

### 9.2 Exporting a seat ("agent as a module")

A seat exports: role charter, persona, skills list, model-policy **declaration**, permission **declaration**, routines, and any docs. It does not export memory, competence, credentials or history. Importing a seat creates a hireable role; hiring it remains the company's decision.

### 9.3 Import

1. Resolve the archive/index entry; verify digest and signatures.
2. Install pinned (§7), record provenance.
3. Validate and write config (defaults or owner-provided).
4. Run conformance (network denied except declared hosts).
5. Enable only on owner approval.

An import is reproducible: the same archive + config yields the same enabled module.

---

## 10. Registry and index

### 10.1 Index format

```json
{
  "format": 1,
  "name": "capheos-official",
  "generatedAt": "2026-11-18T00:00:00Z",
  "modules": [
    {
      "id": "health-ping",
      "version": "1.0.0",
      "kind": "capability",
      "summary": "Probe a URL on a schedule.",
      "license": "MIT",
      "engines": { "caPheOS": ">=0.2" },
      "source": { "type": "tarball", "url": "https://…/health-ping-1.0.0.tgz", "digest": "sha256:…" },
      "publisher": { "name": "…", "keyId": "…" },
      "signature": "…"
    }
  ]
}
```

### 10.2 Trust

- `company/state/registries.json` lists sources with `trusted: true|false`, an optional public key and a pin policy.
- An agent may **read** any configured index and **search** it.
- An agent may **propose** adding a source; only the owner adds one.
- Install from an untrusted publisher requires an explicit owner approval and a risk review row.
- Digests are mandatory; a missing or mismatched digest refuses the install.

---

## 11. Agent-facing tools

| Tool | What it does | Gate |
|---|---|---|
| `unit.search` | query configured indexes; returns matching entries | none (read-only) |
| `unit.inspect` | manifest, capabilities, conformance, provenance of an entry/archive | none |
| `unit.source.propose` | propose adding a registry/index | owner approves |
| `unit.install` | install a pinned entry | owner approves |
| `unit.configure` | write config that validates against the schema | gate `packs` |
| `unit.enable` / `disable` | activate/deactivate | owner approves |
| `unit.export` | produce a portable archive | owner approves |
| `unit.list` / `unit.status` | installed, enabled, broken, available updates | none |

Every tool is declared in the company's tool inventory, has a `--selftest`, and says in its refusal message what the owner must do — an agent can ask a human, never install silently.

---

## 12. Compatibility

### 12.1 DSH — Cordis is the substrate; DSH services are not

CaPheOS adopts **Cordis (MIT)** as its plugin standard — lifecycle, service injection, events, per-plugin config, disposal. That is the extension contract, and it is a standalone framework, not DSH's backend.

| Layer | Adopted? | Code taken |
|---|---|---|
| Cordis plugin contract | **yes** — dependency on the published MIT package | the framework itself |
| CaPheOS manifest, capabilities, conformance | ours | — |
| Skills (`SKILL.md`) | yes — files | none |
| MCP | yes — open standard | none |
| DSH service packages (`@deepseek-ai/dsh-api-*`, `dsh-base`) | only if needed for a chosen plugin | **not by default** |
| DSH client/UI plugins, `dsh-web-app` | never | — |

Interop levels — what "DSH-compatible" actually promises:

| Level | Promise | Status |
|---|---|---|
| **L0** | read/translate DSH manifests and indexes; DSH plugins are **import candidates**; skills and MCP run | default |
| **L1** | **Cordis-generic** plugins run unmodified (they use only `ctx`, events and their own services) | available with Cordis |
| **L1b** | **DSH-service** plugins run — those injecting `@deepseek-ai/dsh-*` services — via a compatibility service layer we implement for the services they actually use | measured, scope in §12.1.1 |
| **L2** | DSH client/UI plugins and `dsh-web-app` | never |

Rules:

- Our `module.json` is the normative manifest; its `dsh` block is an **adapter input**, not an execution promise.
- `inspect` reports the level a plugin needs (L1 vs L1b) and the services it injects.
- L1b is scoped by the measured inventory in §12.1.1: implement only the service names the plugins we care about actually touch, never the whole DSH surface.
- A module whose only value is a client half is refused with that reason.
- No `@deepseek-ai/dsh-*` package is a dependency by default; `engines.dsh` is recorded, not enforced by their code.

#### 12.1.1 Measured: what the installed plugins actually ask for

Method: for every bundle installed in the desktop profile, read the built host half (`lib/index.js`) for `export const inject`, `ctx.get('…')`, `ctx.on('…')` and imports of `@deepseek-ai/*`; then count the live service directory this profile mounts. This is the measurement `unit.inspect` must run on any catalogue entry before the console badges it.

**The installed set is seven plugins from one publisher (the Artifacts family).**

| Plugin | Declared `inject` | Services read | `@deepseek-ai` imports |
|---|---|---|---|
| `dsh-claude-data`, `-design`, `-design-system`, `-motion`, `-slides`, `-whiteboard` | `["skills"]` | — | none |
| `dsh-claude-artifacts` (the page + comment channel) | — | `loader`, `agents`, `agentPresets`, `pluginManager`, `connection` | none |

What that means:

- **The six skill plugins are L1 today.** They are Cordis-generic plus one service — `skills` — and that is a service CaPheOS already has (`company/skills`, 8 `SKILL.md` packs). Adopting Cordis is the only work.
- **The one plugin with a page and a comment channel needs five names**: `loader` (Cordis itself), `agents`, `agentPresets`, `pluginManager`, `connection.fetch.register` for its HTTP routes, plus the `tools/result` event so an opened page can be noted. That is the whole of L1b for this plugin.
- **No host half imports a `@deepseek-ai` package.** The dependency is on the context contract, not on DSH code — which is why L1b is a facade, not a port.
- **Scale check:** this profile mounts **107 services**; the plugins we actually run touch **5**. The ecosystem's surface (the generated package inventory in `references/packages.md`) is real, but it only matters when a plugin we want names a service.

L1b scope, settled by that data:

| DSH name | CaPheOS provides | Work |
|---|---|---|
| `loader` | Cordis | free |
| `skills` | `skills` service (§5.7.2) | already ours; name it as the DSH service |
| `agents` | `agents` service | new host service — required for CaPheOS's own seats anyway |
| `agentPresets` | `seats` presets (roles) | adapter |
| `pluginManager` | `units` service | adapter (installed version, enable/disable, update state) |
| `connection` (routes) | `http` service | adapter |
| `tools/result` | `tools` service event | emit after execution |

So L1b for the current set is **one small compatibility package of six names** — five of which CaPheOS provides or needs for its own modules anyway (`loader` is Cordis itself, `skills` already exists, `agents`/`units`/`http`/`seats` are host services the company layer needs). That is days of work, not a quarter.

What it does **not** get: the client halves. The Artifacts sidebar page is a DSH client plugin (L2). The host half still serves its artifact pages and its comment channel, so the agent-facing value arrives; the DSH-rendered sidebar listing does not, and a CaPheOS panel replaces it (§5.2 `surface`).

Rules this settles:

- The index carries the level (`L1`, `L1b`, `L2`) and the service names, measured at publish time; the console badges an entry before install.
- A mixed plugin installs **host-only**; its surfaces are rebuilt as CaPheOS panels.
- Re-measure when the catalogue grows. The number to watch is the union of service names, not the number of plugins.

### 12.2 MCP

An integration with no UI is preferably an MCP server:

```json
"mcp": { "transport": "stdio", "command": "node", "args": ["mcp/server.js"] }
```

MCP is the portability boundary: the same module works in any MCP host, independent of DSH.

### 12.3 Legacy packs and core modules (v1)

The 12 core modules and the pack scaffold were written without this standard; they are the **migration source, not the
target shape**. `unit.js inspect` still reads a v1 `pack.json` so an author can see what a pack does, but a new
workplace does not install one — it installs format-2 units (§8, no migration). When a pack or core module is touched
it is rewritten as a unit with the same behaviour, one conformance test and a manifest; the old shape is not carried
forward. Mapping for reference: `owner`→`owner`, `requires.*`→`requires.*`, `tools`→`provides.tools`,
`seats`→`provides.seats`, `panels`→`provides.surfaces`, `limits`/`meters` unchanged, `conformance` unchanged.

---

## 13. Conformance

`conformance/test.js` exits `0` conformant, `1` not conformant (prints what is missing), `2` broken (the test itself cannot run). It must check at least:

1. manifest validates against the schema;
2. every listed file exists and nothing unlisted is callable;
3. **the parameterization rule**: no company name, owner, port, host path, timezone, currency or seat name in code, defaults or docs that would break another company; no secret values;
4. config schema validates the defaults and a representative config;
5. declared capabilities match what the code actually uses (static scan of network/fs/subprocess APIs);
6. every meter/limit path is declared and shipped closed;
7. the module runs once in a sandbox with only its declared capabilities (the "denied path" test: an undeclared network call must fail);
8. uninstall leaves no tracked file behind.

A module that has never passed 1–8 is `dormant`, never `enabled`.

---

## 14. Failure and recovery

| Failure | Behaviour |
|---|---|
| Digest mismatch | install refused; entry flagged in `units.json`; owner told |
| Conformance failure after update | automatic rollback to last conformant version; module `broken`; owner told |
| Module crash loop (3 starts) | disabled; data kept; owner told |
| Broker denial at runtime | the call fails closed and is logged; no retry bypass |
| Host package version mismatch | module `broken` before any code runs |
| Registry unavailable | installed modules unaffected; search reports unknown, never absence |
| Uninstall with live work | refused while the module owns an open commitment; unless `--force` and the owner accepts the orphan list |

---

## 15. Phasing

| Phase | Scope | Exit test |
|---|---|---|
| **P0** | host composition spike on published packages; one third-party plugin and one CaPheOS panel in a slot | ecosystem code runs unmodified |
| **P1** | manifest schema + `unit.js` install/enable/export of local archives; parameterization lint | one capability exported from one company and installed into a second |
| **P2** | governance gates + capability broker + decisions-log provenance | a hostile module is refused; a bad update is rolled back |
| **P3** | registry/index reader + agent search/install with approval | an agent imports the capability its work needs |
| **P4** | seat modules (export/import a seat) | a seat moves between companies intact |
| **P5** | DSH-compatible packaging + surfaces; legacy pack migration | the Artifacts host half runs: an opened artifact page reaches the agent through the comment channel, and a CaPheOS stack installs beside it |

---

## 16. Open questions

1. **Naming.** "Module" collides with core modules; alternatives: *unit*, *component*, *capability package*. This spec uses **module** and **core module**; decide before the schema lands.
2. **Owner interface and substrate (decided).** CaPheOS runs **its own console** on a host it owns, with **Cordis (MIT) as the plugin standard**. No `@deepseek-ai/dsh-*` runtime package is a dependency; `dsh-web-app` is neither a dependency nor a fork; DSH UI plugins are out of scope. DSH interop: **L0** by default, **L1** for Cordis-generic plugins, **L1b** only with a measured service-compatibility layer (§12.1).
3. **Registry operation.** Who runs the official index, and does publishing require review by us or only a signature?
4. **Signing.** Digest-only, or publisher keys with signature verification? Start digest-only; keys later.
5. **Monorepo vs separate repositories** per module. The export format is identical either way; authoring convenience decides.
6. **Licence policy** for published modules and for vendored ecosystem code (`NOTICE` discipline).
7. **Seat modules and competence.** An imported seat starts at zero competence in its new company; confirm that is accepted (it is the honest behaviour).
8. **L1b service compatibility (measured — §12.1.1).** Cordis is adopted, so Cordis-generic plugins run. The installed set needs six names in total: `loader` (Cordis), `skills` (already ours), `agents`, `agentPresets`, `pluginManager`, `connection` (routes), plus the `tools/result` event. The remaining question is only placement: which of those names live in the host's service catalogue and which live in a separate compatibility module. Decide when the first plugin is installed in P5; do not take the DSH packages.

---

## Appendix A — stack example

```json
{
  "format": 2, "id": "content-studio", "version": "0.1.0", "kind": "stack",
  "title": "Content studio", "summary": "A short-video studio: an editor seat, a renderer, a publishing workflow.",
  "license": "MIT", "engines": { "caPheOS": ">=0.2" },
  "requires": { "modules": ["video-render@^1", "research-analyst@^1"], "guardrails": ["externalActions"] },
  "capabilities": {},
  "provides": { "stacks": [] },
  "docs": ["README.md"], "limits": [{ "file": "limits/studio.json", "owner": "finance", "why": "daily render cap" }],
  "conformance": { "test": "conformance/test.js" }
}
```

## Appendix B — state files

```json
// company/state/units.json
{
  "format": 1,
  "units": {
    "health-ping": {
      "version": "1.0.0", "kind": "capability", "state": "enabled",
      "digest": "sha256:…", "source": "registry:capheos-official",
      "installedAt": "…", "enabledAt": "…", "approvedBy": "owner",
      "grants": { "network": ["api.example.com"], "fs": ["company/work/units/health-ping/**"] }
    }
  }
}
```

```json
// company/state/registries.json
{
  "format": 1,
  "registries": [
    { "name": "capheos-official", "index": "https://…/index.json", "trusted": true, "pinned": "sha256:…" }
  ]
}
```
