# CaPheOS

**The operating system for a company that runs on agents — governed like a company, built from portable units, deployed as one container.**

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/licence-AGPL--3.0--or--later-blue)](LICENSE)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](#roadmap)
[![Node: 22](https://img.shields.io/badge/node-22-brightgreen)](https://nodejs.org)

CaPheOS is software you run to operate a company staffed by agents. It gives you the parts every company
needs before it can be trusted with real work — **who decides, what may leave, what may be spent, who owns
the work, and what happened** — and a standard for the capabilities that make the company *that* company.

It ships no company and no vertical. A law firm, a trading desk, a content studio and an overnight
operations centre start from the same image and become themselves through their charter and their units.

> **Pre-release.** This README describes the release. The two workstreams before publication are the
> **backend rewrite** (`docs/BACKEND.md`) and **containerized deployment** (`docs/DEPLOY.md`). Their plan,
> acceptance test and exit tests are in the tree; the old runtime is still what `main` runs.

---

## Contents

1. [What it is](#1--what-it-is)
2. [Where it runs](#2--where-it-runs)
3. [Why it exists](#3--why-it-exists)
4. [How it works](#4--how-it-works)
5. [The unit standard](#5--the-unit-standard)
6. [Roadmap](#6--roadmap)
7. [Repository layout](#7--repository-layout)
8. [Run it](#8--run-it)
9. [Documentation](#9--documentation)
10. [Contributing](#10--contributing)
11. [Security](#11--security)
12. [Licence](#12--licence)
13. [Acknowledgements](#13--acknowledgements)
14. [The ask](#14--the-ask)

---

# 1 · WHAT it is

## 1.1 One paragraph

CaPheOS is a company operating system. You run one container, open the owner console in a browser, and set
up a company: name it, connect an AI provider, set a budget, write a charter, and hire. From then on the
company runs — **seats** own work, a **dispatcher** wakes whoever is needed, money is spent inside caps,
everything that leaves passes one **external gate**, and every decision is recorded. The work itself comes
from **units**: versioned, installable, exportable capabilities.

It is not the AI, and it is not a company. It is the layer around the AI that makes a company possible, and
the layer around the company that makes it trustworthy.

## 1.2 The analogy

An operating system does not do your work. It gives you users, permissions, scheduling, storage, and a way
to run programs.

CaPheOS is that, for a company:

| Operating system | CaPheOS |
|---|---|
| users and groups | seats and functions (`ceo`, `people`, `tools`, `risk`, `finance`) |
| permissions | owner gates, guardrails, the external-action gate |
| the scheduler | the dispatcher |
| processes | tasks, commitments, handoffs, duties, meetings |
| storage | decisions, ledger, incidents, transcripts, continuity — the company's memory |
| applications | units: capabilities, workflows, seats, surfaces |
| the desktop | the console |

**The OS is the product. The units do the work. The permissions are why you'd trust it.**

## 1.3 What you get

- **The console** — the owner's whole interface in a browser: Today, people, work, money, approvals, meetings,
  connections, system. No terminal for the owner.
- **Five functions** — `ceo`, `people`, `tools`, `risk`, `finance` — held by a Founder on day one and hired out
  as the company grows.
- **A dispatcher** — wakes the seat that owns open work, on evidence, and only when that work can progress.
- **Governance** — guardrails that fail closed, one external gate, secrets custody, locked files, review
  without self-approval, a decision record.
- **Money** — budgets per period, quotas for subscription plans, approvals above a threshold, holds that never
  stall a critical path, a ledger.
- **Work** — tasks with steps and evidence; commitments with owners and deadlines; handoffs; duties; meetings
  with minutes and an action register; incidents; continuity.
- **Memory** — the decisions log, ledger, transcripts, meeting records, incident history: a company that can
  explain itself.
- **A unit standard** — the extension mechanism, from capability to seat, with a registry.
- **One process, one container, one port** — the backend serves the console and runs the agents itself.

## 1.4 What it is not

| It is not | Because |
|---|---|
| a model | it uses the providers you connect |
| a chatbot | it runs a company, not a conversation |
| a hosted SaaS | it runs on your machine or server; hosting is an option |
| a no-code builder | companies are charters, seats and units, not screens |
| an autonomous company | the owner sets the gates, budgets and limits; agents cannot widen them |
| a company | nothing here is a business until a charter, people and work make it one |

---

# 2 · WHERE it runs

## 2.1 One container, one process

The release artifact is **one immutable image**. Inside it, the console server and the runtime are **the same
Node process** (`server/` + `runtime/`): one port, no proxy, no second token, no second service to trust.

- **The owner in a browser** — same machine, the LAN, or remote over HTTPS; phone-friendly. Sign-in is a real
  sign-in page; the backend token never reaches the browser.
- **The company's data lives outside the image** — on an encrypted volume, mounted by UUID, with a mount
  guard and a single-writer lock.
- **Supervision is s6 as PID 1** — runtime, dispatcher, liveness, console. Graceful stop drains, halts soft,
  records continuity, stops.
- **The root filesystem is read-only.** Updates are images, not patches.

## 2.2 Where everything lives

| Thing | Where |
|---|---|
| The company | one compose project per company, with its own volume and ports |
| Working data and decisions | `company/work`, `company/state` — on the encrypted volume |
| Secrets | `secrets/`, one file per key, never in git, never in prompts |
| Models | providers over the network; subscription CLIs only on a desktop, API keys on servers |
| Units | pulled from a registry on demand, content-addressed, installed into the company's unit store |
| Backups | quiesced snapshots to a second copy; restore tested |
| Remote access | the console over HTTPS; no inbound agent ports |
| Desktop and browser work | a disposable Linux microVM plugin — never the owner's live session |

## 2.3 Deployment shapes

| Shape | What it means |
|---|---|
| **Evaluation** | one small server or VM, one company, a free provider tier, a small budget |
| **Production** | one compose project, the encrypted drive, TLS, backups, an API-key provider |
| **Hosted** | we run it for you: infrastructure, updates, backups, AI credits metered per use |

---

# 3 · WHY it exists

## 3.1 The problem

Agent companies built today are monoliths. Agents, tools, integrations and policies are welded into one
environment.

- When the company changes, **you rebuild**.
- When it fails, **nothing survives**.
- When it succeeds, **you can't share what worked**.
- And while it runs, **nobody can say who allowed what** — which is why it cannot be trusted with money,
  clients or reputation.

## 3.2 The thesis

Split the monolith into two parts that should never have been fused:

1. **The company layer** — authority, money, work, memory. The same for every vertical.
2. **The capability layer** — units. Versioned, installable, exportable, publishable.

| | Everyone else | CaPheOS |
|---|---|---|
| **The unit** | one environment | one unit |
| **Reuse** | copy the repo | install the unit |
| **Failure** | everything lost | the parts survive and republish |
| **Authority** | "the agent decided" | owner gates, review, audit |
| **Money** | an API bill | budgets, quotas, holds, approvals |
| **Extending it** | rewrite the harness | publish a unit |
| **Trust** | hope | design |

The consequences are the product:

- **The company is a composition** — a Founder plus a stack of units.
- **The unit of value is the unit** — a capability that outlives the company.
- **The governance is the product** — a plugin ecosystem without authority is a supply-chain risk; a company
  OS without governance is a liability.

## 3.3 Why now

- **The plugin ecosystem matured.** Cordis — MIT — is the extension standard behind a fast-growing agent
  harness ecosystem: lifecycle, services, events, per-plugin config, disposal. MCP is the open standard for
  integrations.
- **The licences are permissive.** MIT and BSD packages mean the mechanism is reusable, forkable and pinnable.
- **Agents can extend the system themselves.** Under review, as everything else is.
- **Nobody built the company layer.** The ecosystem answered *"what can be loaded?"* Nobody answered *"who
  may load it, who reviewed it, what may it touch, what did it cost, and who owns it when the company ends?"*

## 3.4 Who it's for

- **The operator starting a second company** — don't rebuild what worked; install it.
- **The agency running real client work** — approvals, audit, budgets and incident records are what clients
  ask for before they trust you with their systems.
- **The regulated team** — segregation of duty, review trails, fixed owner gates, an external gate a
  compliance officer can read.
- **The builder with a capability worth selling** — write a unit once; every CaPheOS company can install it.
- **The investor** — a hundred agent demos, and the hundred-and-first is a company that can be audited.

## 3.5 What you can build with it

| Vertical | What the company layer gives you | What a unit adds |
|---|---|---|
| **Content studio** | seats, review, budgets, publishing gates, meetings | renderers, asset pipelines, channel publishing, analytics |
| **Leads desk** | compliance gates, approval above threshold, message audit | prospecting, enrichment, sequences, CRM sync |
| **Overnight operations (NOC)** | coverage windows, duties, escalation, incidents, continuity | probes, runbooks, paging, client reports, SLA clocks |
| **Research / trading desk** | risk limits, approvals, decisions, reconciliation | market data, backtests, order adapters (paper first), positions |
| **Professional practice** | matter ownership, confidentiality, decision rights, records | intake, drafting, precedent libraries, reporting |
| **Library / archive** | cataloguing duties, access policy, retention | metadata, discovery, digitisation, lending |
| **Internal operations** | hiring, budgets, incidents, meeting cadence | integrations with systems you already run |

**Authority, money, work and memory from CaPheOS; one line of business from a unit.**

---

# 4 · HOW it works

## 4.1 One process, three layers

```
┌──────────────────────────── one container · one process ────────────────────────────┐
│  HTTP face: console API (frozen contract) · runtime API · SSE events                 │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Cordis composition — every service is a plugin:                                     │
│    company · seats · tasks · runs · models · tools · approvals · budget ·            │
│    schedule (the dispatcher) · transcripts · units                                   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Storage: company/state (state) · company/work (work) · per-run JSONL                │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Same on every deployment? | What it is |
|---|---|---|
| **Core harness** | yes | the HTTP face, the run loop, the provider interface, the tool host, the task and transcript stores, approvals, budget, the scheduler |
| **Bootstrap kit** | yes | what a new company runs from founding to its first hires: setup, the console surfaces, dispatcher and duties, approvals, budget, governance, handoffs, hiring, competence, commitments, intake, meetings, connectors, skills, backup and liveness |
| **Units** | **no** | tools, integrations, provider adapters, seats and vertical stacks — pulled from a registry and mounted by the Founder's decisions |

**The new-company state is the same everywhere.** A company differs only by the units it mounts.

## 4.2 One turn

1. **A run starts** — a seat's charter, function, skills, model policy, tool grants and budget are assembled
   from company files.
2. **The model streams** text, tool calls, usage and a terminal status; a refusal is a normal answer, not a
   crash.
3. **Tools run** through one host with the capability and consent gates; results go back into the turn.
4. **Anything the owner must decide** becomes one question on Today; the answer returns into the run.
5. **The record is written** — the transcript is the canonical memory; the run journal lets the console
   re-attach after a restart or a reload.
6. **A task closes on evidence**, not on a click.

## 4.3 Seats are functions

Every tool finds people by the function they hold, never by name. A company can hire in any order, grow
without rewiring, and survive a person leaving.

| Function | Owns |
|---|---|
| `ceo` | strategy, opening roles, the only seat that writes to the owner |
| `people` | hiring rounds, charters, performance, model choices |
| `tools` | the harness: tools, skills, units |
| `risk` | access, secrets, the external gate, locked files, compliance |
| `finance` | budgets, pacing, the ledger |

The Founder holds all five on day one. The **owner** holds four fixed gates no agent may pass: access and
credentials, ownership and legal, outside commitments, and spend beyond the cap.

## 4.4 Money

- One budget per period, quotas for subscription plans, a hard stop.
- Approvals above a threshold go to the owner — one tap, with a recommendation and the cost of each option.
- The critical path is never silently stalled: if a needed seat is out of budget, the engine opens one
  question — raise, end the period, or wait.
- Every call has a price on the record; unmetered usage is reported as unknown, never as free.

## 4.5 Governance

- **Guardrails** with owner-only switches; unknown state reads as ON.
- **One external gate** for everything that leaves: message, publish, account, form, spend, network.
- **Secrets** never in git, never in prompts; read by name.
- **Locked files** for anything that measures or limits the company.
- **Review without self-approval** — a shared change is proposed, reviewed, backed up, and checked again
  three days later.
- **Stated limits** — where the platform cannot prevent something, the threat model says so.

## 4.6 Deployment and the desktop

The release is **containerized**: an immutable image, s6 as PID 1, a read-only root, the company's data on an
encrypted volume (btrfs on LUKS), a mount guard, quiesced snapshot backups, a host-side updater bridge (no
Docker socket in the app), `/readyz` and an external dead-man.

Browser and desktop work is a **plugin, not core**:

- a disposable **Linux microVM** with no host mounts, no Docker socket, an egress allowlist, PID/memory caps
  and a kill switch;
- a real headed Chrome with a dedicated profile per identity — never the owner's signed-in session;
- **grants, leases and tiers**: a grant is origins + identity + capability + window + rate + expiry +
  revocation; tiers 0–3, tier 3 per-session with re-consent; escalation on payment fields is automatic, and
  de-escalation is owner-only;
- a **security seat** that sweeps ports, egress, grants and drift, with a locked findings record.

Details: `docs/DEPLOY.md`.

## 4.7 A day inside

**02:14** — a duty probes a client's site. It is down. A task opens; the same failure does not open a second
one. The dispatcher wakes the on-call seat and no one else. A grant given at onboarding, expiring at contract
end, lets it page the client's on-call; the page goes out and is logged. The owner is asleep — the alerting is
deterministic, not a model.

**07:40** — the owner opens the console on a phone. **Today** shows one decision: a spend approval the task
needs, with a recommendation, a default and the cost of each option. One tap.

**09:00** — the morning meeting. The seats sit at one table; the leader speaks first; each answers in turn;
anyone with nothing to add passes. The owner reads at their own pace and presses Next. Rulings land in the
decisions log; the action register gets owners and dates; kill conditions are recorded.

**18:00** — the budget nears its line. The engine opens one question — raise, end the period, or wait — and
stops paying for wakes that cannot progress.

**Months later, the company winds down.** The unit and the seat are exported, with licences, capabilities and
conformance tests. Memory, money and client data stay behind. The parts go on to the next company — in an
afternoon.

---

# 5 · THE UNIT STANDARD

A **unit** is a plugin with a manifest: the portable unit of capability. Packs are the first form; the full
standard is `docs/MODULE-SYSTEM.md`.

```jsonc
// module.json — a capability unit
{
  "format": 2,
  "id": "health-ping",
  "version": "1.0.0",
  "kind": "capability",
  "title": "Health ping",
  "summary": "Probe a URL on a schedule and open a task when it is down.",
  "license": "MIT",
  "engines": { "caPheOS": ">=0.2", "node": ">=22" },
  "requires": { "coreModules": ["observe", "intake"], "guardrails": ["externalActions"] },
  "capabilities": {
    "network": ["api.example.com"],
    "fs": { "read": ["company/work/units/health-ping/**"], "write": ["company/work/units/health-ping/**"] },
    "secrets": [],
    "subprocess": false
  },
  "conformance": { "test": "conformance/test.js" }
}
```

- **Kinds:** `capability`, `workflow`, `seat`, `surface`, `stack`.
- **Lifecycle:** discover → install → dormant → configured → conformant → enabled → export.
- **The parameterization rule:** a unit that names its company cannot leave it.
- **No ambient authority:** declared capabilities only, granted by a broker, revoked on disable.
- **Export/import:** a unit or a seat, without company memory or secrets.
- **A registry:** agents can search and install what the work needs, with the owner's approval.

A plugin shipped with the base is enabled in the default composition. A capability the owner adds is a unit.
**Both are the same mechanism**, so there is one way to extend the backend and one way to remove something.

---

# 6 · ROADMAP

Publication follows two workstreams. Both have an exit test; neither is "done" until it passes.

## 6.1 The backend rewrite

Replace the borrowed agent runtime with **one process that serves the console and runs the agents itself.**
No proxy, no second port, no second token. The console contract is frozen; the frontend does not change.

| Phase | Work | Exit test |
|---|---|---|
| **P0** | Freeze and test the console contract; task, run and transcript formats; vocabulary lint | the contract test passes against today's console |
| **P1** | One seat's turn, streamed, with one tool | a chat message gets a streamed reply and a stored transcript, with no station anywhere |
| **P2** | Work tools rewritten on tasks | no business tool mentions the old work model |
| **P3** | Schedules become the dispatcher; the proxy is deleted | the dispatcher wakes seats with no station anywhere |
| **P4** | Provider and spend parity; meetings on the new runtime | a meeting and a routine both run; spend rows match |
| **P5** | No reference to the old runtime in the framework tree | `grep -r starnet` is empty |

**No migration.** Existing workplaces keep the old stack; new workplaces are founded fresh. Acceptance is a
**parity ledger** — 18 areas, three gates, and a bloat ledger where every cut has a row (`docs/PARITY.md`).

## 6.2 Containerization

| Phase | Work |
|---|---|
| **P0** | Image, s6, encrypted drive and mount guard, framework manifest, tool split, read-only audit, CI certify |
| **P1** | Compose, proxy and TLS, dead-man, updater bridge, quiesced backup and restore |
| **P2** | Safe Cell shell isolation, Chromium sidecar, grants/leases/revocation, security bundle |
| **P3** | Desktop microVM, driver abstraction, auto-escalation, risk acceptance |
| **P4** | Multi-company |

`docs/DEPLOY.md` is the plan of record.

## 6.3 Status, honestly

**Working today on `main`:** the company layer, governance, money, work, meetings, decisions, incidents,
continuity, console, packs, instance guard, backups, framework updates, tests, CI, and a headless deployment.

**In progress:** the backend rewrite and the containerized deployment above.

**Alpha means alpha.** The parts that are built are tested. The parts that aren't are named.

---

# 7 · REPOSITORY LAYOUT

| Path | What |
|---|---|
| `server/` | the process: console HTTP face, runtime API, SSE |
| `runtime/` | the backend services and the run loop; the only place with a dependency (Cordis) |
| `company/` | the business layer: charter, seats, tools, units, skills, policies, schemas |
| `console/` | the owner console: UI and its frozen HTTP contract |
| `modules/` | core modules: intake, observe, parties, commitments, playbooks, scopes, verify, evidence, reports, ledger, liveness, continuity |
| `packs/` | capability packs (the first form of a unit), with the scaffold |
| `vendor/` | vendored third-party code, each with licence and provenance |
| `docs/` | the design: backend, parity, founding, units, deployment, licensing, style |
| `scripts/` | founding, setup, tests, backup |
| `tests/` | end-to-end walks and parity tests |
| `container/` | the release image: `Dockerfile` and the s6 service |
| `capheos.yml` | one compose project per company |
| `SECURITY.md` · `CODE_OF_CONDUCT.md` · `.github/` | policy, community and contribution templates |
| `secrets/` | keys, one file each (gitignored) |

Most of the 80-tool toolbag **moves to the units repository** — an adjacent index of units, pulled on demand.
This repository keeps the core, the bootstrap kit and the installer.

---

# 8 · RUN IT

## 8.1 The release (after containerization)

```bash
# image: container/Dockerfile — one compose project per company; data outside the image
docker compose -f capheos.yml up -d
```

Then open the console and run **Setup**: connect a provider, set a budget, write the charter, choose how much
the company decides alone, review the guardrails, certify. The company is operational when certification is
green — not before.

> The compose file and image land with the containerization workstream. Until then, run from source.

## 8.2 From source (development)

```bash
git clone https://github.com/<owner>/CaPheOS.git
cd CaPheOS
npm ci --prefix runtime          # the runtime's one dependency, pinned
scripts/test.sh                  # the offline suite
scripts/test-runtime.sh          # the runtime's own tests
scripts/found-company.sh --name "Example" --owner "Alex"
```

Founding creates a workplace, picks free ports, starts the runtime, dispatcher, liveness and console, and
opens the console. `docs/FOUNDING.md` is the flow: bootstrap → setup → certification → launch.

> **Never found a company in the framework checkout.** Two checkouts, always: one to develop the framework,
> one per company. The instance guard enforces it.

---

# 9 · DOCUMENTATION

| Document | What it settles |
|---|---|
| `docs/VISION.md` | where CaPheOS is going and why, and how a change is judged against it |
| `docs/BACKEND.md` | the backend rewrite: one process, the core, the contract, vendoring, the phases |
| `docs/PARITY.md` | the acceptance test: 18 areas, three gates, the bloat ledger |
| `docs/FOUNDING.md` | bootstrap, setup, certification, launch |
| `docs/MODULE-SYSTEM.md` | the unit standard: manifest, lifecycle, registry, service surface, interop |
| `docs/DEPLOY.md` | container, encrypted drive, grants and leases, the security seat |
| `docs/STYLE.md` | plain language: the rule for every name, comment and error |
| `docs/LICENSING.md` | AGPL, the commercial licence, the CLA, vendoring rules |
| `docs/CONSOLE-API.md` | the frozen frontend contract |
| `docs/GUARDRAILS.md` · `docs/DECISION-MODELS.md` · `docs/DUTIES.md` · `docs/BUDGET.md` · `docs/MEETINGS.md` | the company layer |
| `docs/CONNECTORS.md` · `docs/DEPS.md` · `docs/PACKS-SPEC.md` | integrations and extensibility |
| `docs/DEPLOY-SERVER.md` | running it on a server |
| `CONTRIBUTING.md` · `CLA.md` | how to contribute, and the sign-off |

---

# 10 · CONTRIBUTING

Read `CONTRIBUTING.md` once. The [code of conduct](CODE_OF_CONDUCT.md) applies in every project space. The short version:

1. **Plain language is binding** (`docs/STYLE.md`). If a name has to be explained, it is wrong.
2. **No company data** — never a real name, owner, customer, path, port, timezone or secret.
3. **Keep the tests green** — `scripts/test.sh` runs the whole offline suite against a temp copy.
4. **One dependency is a decision**, not a convenience.
5. **A cut needs a row** in `docs/PARITY.md`; no silent removals.
6. **Vendored code keeps its licence** and gets a `NOTICE` row.

**Sign-off and the CLA.** Every commit: `git commit -s` (DCO). First pull request: the statement in
`CLA.md`. You keep your copyright; the project needs the right to license your contribution under the AGPL
and commercially.

Issues and pull requests are for behaviour, not for code you want to write. Say what you are trying to do
and what is in your way.

---

# 11 · SECURITY

- Report a vulnerability privately through GitHub's **security advisories**, or to the project owner — never
  in a public issue. The full policy is [SECURITY.md](SECURITY.md).
- The threat model is stated, not implied: `docs/GUARDRAILS.md` and `docs/DEPLOY.md` §3–§5 cover the
  execution boundary, the browser grants and the desktop microVM — including what is *not* enforced.
- Modules and units declare capabilities; the broker grants only those; undeclared access fails closed.
- A unit is code execution. Installing one requires the owner's approval, a verified digest and a
  conformance test; disabling revokes its grants.

---

# 12 · LICENCE

- **Code:** AGPL-3.0-or-later (`LICENSE`). Use it for anything, personally or commercially. If you modify it
  and let others use it over a network, you must offer them the source. The code never becomes closed.
- **Commercial licence:** the same code, without the copyleft obligations, for companies that cannot open
  their modifications. Terms per customer.
- **Documentation:** CC BY-NC-SA 4.0.
- **The name and marks** are not licensed.
- **Units** published to the registry carry the author's choice of an OSI-approved licence.
- **Contributions:** under the CLA (`CLA.md`) plus a DCO sign-off (`git commit -s`).

StarNet's name and artwork are not covered by its MIT licence. CaPheOS uses its own name and art; vendored
code keeps its licence and a `NOTICE` row.

---

# 13 · ACKNOWLEDGEMENTS

- **[Cordis](https://github.com/cordiverse/cordis)** — MIT. The plugin standard the runtime is built on.
- **StarNet** — MIT. Provider adapters, the MCP client and the streaming event vocabulary are vendored with
  attribution; every identifier is renamed to CaPheOS vocabulary.
- **MCP** — the open standard for integrations.
- Every contributor who opens an issue, a pull request or a unit.

---

# 14 · THE ASK

- **Run a company on it** — and tell us where it hurts.
- **Publish a unit** — if you can build it, someone else needs it.
- **Become a design partner** — a real operation, a real charter, a shared roadmap.
- **Licence it commercially** if you need it without the copyleft.
- **Star the repo** — it is how the right people find it.

If you have watched a hundred agent demos and thought *"none of this could run a business"* — this is the one
built for that objection.

**CaPheOS. Assemble a company from parts that outlive it.**
