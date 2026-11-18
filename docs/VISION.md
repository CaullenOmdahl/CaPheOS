# Where CaPheOS is going

Where CaPheOS is going and why, for the owner, contributors and the seats that run on it. It adds no rules: each
principle points to the document that enforces it, and each question in §6 cites where its rule already lives. If they
disagree, that document wins and this page is corrected.

> **Pre-release.** §1 describes the release, as the README does. §5 says what is built today and what is not; the old
> runtime is still what `main` runs.

---

## 1. The vision in one paragraph

CaPheOS is the operating system for a company that runs on agents. At release, you run one container, open the console
in a browser, and set up a company: connect a provider, set a budget, write a charter, hire. From then on seats own the
work, a dispatcher wakes whoever is needed, money is spent inside caps, everything that leaves passes one external
gate, and every decision is recorded. The work comes from units: versioned capabilities you install, export and
publish. The framework ships no company and no vertical; each company becomes itself through its charter and its units.
The units outlive it: when a company fails, the parts survive and republish.

## 2. The problem it answers

Agent companies today are monoliths: agents, tools, integrations and policies welded into one environment. When the
company changes, you rebuild. When it fails, nothing survives. When it succeeds, you cannot share what worked. While it
runs, nobody can say who allowed what, so it cannot be trusted with money, clients or reputation.

Why now ([README](../README.md) §3.3): the plugin ecosystem has matured, with an open extension standard and an open
standard for integrations. The licences are permissive, so the mechanism can be reused, forked and pinned. Agents can
extend the system themselves, under review like everything else. But the ecosystem answered "what can be loaded?".
Nobody answered "who may load it, who reviewed it, what may it touch, what did it cost, and who owns it when the company
ends?".

## 3. The thesis, and the principles that follow

**The thesis:** split the monolith into two layers. The **company layer** (authority, money, work, memory) is the same
for every vertical. The **capability layer** is units.

- **Governance is the product.** Plugins without authority are a supply-chain risk. Guardrails fail closed: an
  unknown or missing switch reads as ON, and only the owner changes one. → [GUARDRAILS.md](GUARDRAILS.md)
- **The owner never needs a terminal.** The console is the owner's whole interface. Anything the owner must decide
  becomes one question on Today. Installing the server is the server admin's job, not the owner's.
  → [README](../README.md) §1.3, [CONSOLE-API.md](CONSOLE-API.md), [DEPLOY-SERVER.md](DEPLOY-SERVER.md)
- **The framework names no company.** No company, owner, path, port, timezone or secret in framework code. Seats are
  found by function, never by name. → [PORTING.md](PORTING.md), [MODULE-SYSTEM.md](MODULE-SYSTEM.md) §3
- **One gate for every start.** Every start the company makes calls one gate first; a run started inside another run
  is attributed to the run that started it. Today the gate counts and the existing rules decide; later phases let it
  decide, so nothing starts around it. → [BUDGET.md](BUDGET.md) "The doors" lists each start and the exceptions
- **Finding work is a duty, not a model run.** A read-only check in code decides whether to wake someone, and hands
  the reason over. → [DUTIES.md](DUTIES.md)
- **Provenance and owner-only actions.** An owner answer counts only when an allowed writer recorded it. Four fixed
  gates no agent may pass: access and credentials, ownership and legal, outside commitments, and spend beyond the cap.
  Nothing approves its own change. → [PORTING.md](PORTING.md) rule 4, [README](../README.md) §4.3,
  [GUARDRAILS.md](GUARDRAILS.md)
- **Measured, not assumed.** Every call has a price on the record; unmetered usage is reported as unknown, never as
  free. Every cut has a ledger row. → [README](../README.md) §4.4, [BUDGET.md](BUDGET.md), [PARITY.md](PARITY.md) §6
- **Safe defaults, recorded opt-ins.** The owner is the risk authority. Deeper access is an opt-in, and every opt-in
  is recorded. → [DEPLOY.md](DEPLOY.md) §0
- **Plain language is binding.** If a name has to be explained, it is wrong. → [STYLE.md](STYLE.md)

## 4. Who it is for, and what it is not

**For** the operator starting a second company who wants to install what worked; the agency whose clients ask for
approvals, audit and budgets first; the regulated team that needs segregation of duty and review trails; the builder
who writes a unit once for every company to install; the investor who has seen a hundred agent demos and wants the
hundred-and-first to be a company that can be audited. → [README](../README.md) §3.4

**Not** a model (it uses the providers you connect), not a chatbot, not a hosted service (hosting is an option), not a
no-code builder, and not an autonomous company: the owner sets the gates, budgets and limits, and agents cannot widen
them. Nothing here is a business until a charter, people and work make it one.

## 5. Where it is going

Each direction has an exit test, and none is done until its test passes ([README](../README.md) §6). **Built:** on
`main` and tested. **Being built:** work has landed, the exit test has not passed. **Planned:** designed, not
implemented. Alpha means alpha: the parts that are built are tested, and the parts that are not are named here.

| Direction | What it means | Status |
|---|---|---|
| **The company layer** | everything README §6.3 lists as working today: governance, money, work, meetings, decisions, incidents, continuity, the console, packs, the instance guard, backups, framework updates, tests, CI and a headless deployment | **Built.** |
| **The backend rewrite** | one process that serves the console and runs the agents itself, with plain names (STYLE.md vocabulary) and the console contract frozen. No migration: new workplaces are founded fresh. Done when the three parity gates pass (the console contract test, the day-in-the-life walk, the kept tools' selftests) and no reference to the old runtime is left in the framework tree. | **Planned.** The design decisions are taken (BACKEND.md §10); there is no code yet, and the old runtime still runs `main`. |
| **Containerized deployment** | one immutable image, a read-only root, data on an encrypted volume, tested backups, updates from outside the app; later shell isolation, browser grants, a disposable desktop machine, several companies per host. Most of the tool set moves to the units repository, pulled on demand (README §7). | **Being built.** The image skeleton is in the tree; it starts when the new backend's process lands. |
| **The module system** | a unit gets only the capabilities it declares; install, enable and export are governed acts; agents search a registry and install with the owner's approval | **Planned.** A draft specification; packs are the first form. |
| **Middle management and a model ranking** | departments as data, each with a lead function that mostly advises: it keeps a brief, reviews work and steps in when an item is stuck. Its verdict stays advisory until data shows it predicts fewer defects. Each worker is to run on the cheapest model that holds quality for its kind of work, ranked from the company's own accepted work: first-time acceptance, rework, defects, cost per accepted item. The owner can veto. | **Being built.** On `main`: the measurement code, departments as data, the house ranking (read-only, with routing proposals in shadow) and a one-run model choice limited to models open for that seat. The two-week baseline is not done yet; the trials and the leads are being built. → [RANKING.md](RANKING.md), [DEPARTMENTS.md](DEPARTMENTS.md) |

## 6. How a change is judged

This is the one test this page sets, and it only gathers rules that already exist. A change moves into the framework
when every answer is yes, each citing the document named.

1. **Company-neutral.** Would a law firm, a trading desk and a content studio all want it unchanged? No names,
   customers, products, paths, ports, timezone, measured numbers or dated rulings. The PORTING.md grep is the floor
   under this question. → README intro, CONTRIBUTING rule 2, PORTING.md rules 1–5
2. **Right layer.** Core, what a new company runs until its first hires, or a unit? A line of business or an
   integration is a unit. → README §4.1, §5, §7
3. **Survives the rewrite.** It does not depend on the runtime being removed. → README §6.1 P5, BACKEND.md, PARITY.md
4. **Governance holds or tightens.** It widens no agent's power, weakens no gate, approves nothing of its own.
   → README §3.2, §4.5, GUARDRAILS.md
5. **The owner stays in the console.** No terminal, and the console contract is kept or the change is named.
   → README §1.3, §6.1, CONSOLE-API.md
6. **Earns its place.** Parity or stated extensibility, not unused weight. A new dependency is a decision.
   → PARITY.md bloat ledger, CONTRIBUTING rule 4, DEPS.md
7. **Plain and tested.** Plain names; the offline suite passes; growing files are bounded; wake checks are duties.
   → STYLE.md, PORTING.md rules 6, 8 and 9, `scripts/test.sh`

When the documents do not settle it, the change is a direction question for the owner. A builder never judges their
own change.

## 7. The detailed documents

- [README](../README.md): what it is, where it runs, why, the roadmap
- [BACKEND.md](BACKEND.md) and [PARITY.md](PARITY.md): the rewrite and its acceptance test
- [DEPLOY.md](DEPLOY.md): the container, the encrypted drive, grants
- [MODULE-SYSTEM.md](MODULE-SYSTEM.md): the unit standard
- [FOUNDING.md](FOUNDING.md): bootstrap, setup, certification, launch
- [GUARDRAILS.md](GUARDRAILS.md), [BUDGET.md](BUDGET.md), [DUTIES.md](DUTIES.md): the company layer's rules
- [PORTING.md](PORTING.md) and [STYLE.md](STYLE.md): keeping it company-free and plain
- [CONTRIBUTING](../CONTRIBUTING.md) and [DEPS.md](DEPS.md): the contribution rules and the dependency set
- [LICENSING.md](LICENSING.md): AGPL, the commercial licence, contributions
- [FEATURES.md](FEATURES.md): the old runtime's full feature list; PARITY.md picks what is kept
