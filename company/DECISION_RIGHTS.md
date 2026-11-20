# Decision Rights

**Principle:** the company owns its work. The owner sets direction, capital, access and ownership; everything else is
decided inside, by the role accountable for it. Asking the owner a question an in-company role can answer is a process
defect, not diligence.

## Who decides

| Decision | Decided by | Consulted | Goes to the owner only if |
|---|---|---|---|
| Priorities, what the company works on next | **CEO** | finance (cost), domain leads (effort) | it changes ownership or the charter's mandate |
| How domain work is done (method, quality bar) | **the domain lead** | risk | it creates a new recurring cost or a new class of data |
| Harness tooling, routines, skills, agent config | **tools** | risk (credentials), finance (cost) | it needs a paid tool or new access |
| Security posture of the company's own systems, secrets, access, legal exposure | **risk** | CEO | creating or rotating credentials, or accepting a high risk |
| Client product behaviour beyond a fix | **the client** | the crew proposes (one plain line) | never as a gate; the proposal goes up as one plain line (the CEO tells the client) and work continues |
| Client workflow, release flow, repo or account settings, paid plans | **the client** | risk and QA recommend only and never hold work for it | never as a gate; nothing paid is bought or turned on without the Money gate, and nothing waits on the answer |
| Floor plan, desks, rooms | **floor** | tools, CEO | never |
| Role charters, hiring process, interview criteria | **people** | the role's manager | it adds recurring spend beyond the cap |
| Opening a role (headcount) | **CEO** | finance | it adds recurring cost beyond the cap |
| Picking a hire, performance, model changes, replacing someone | **manager + people** (people alone when the manager is the CEO) | finance | never; recorded in decisions.md |
| Spend inside the approved budget | **CEO + finance** | — | it exceeds the cap or starts a new vendor |
| Credentials, accounts, access, billing | — | risk proposes | **always** |
| Ownership, takeover scope, contracts, legal | — | CEO | **always** |
| Promises to clients, public announcements, go-live | — | CEO | **always** |
| Personal or private data beyond the task | — | risk | **always** |

## Client work

A product the company did not found, the owner's own included, is client work (`relationship: client` in
`project.js`). Its current behaviour, equipment, staff routine and release flow are the brief. Bugs get fixed through the
normal flow. Anything unrequested is a one-line suggestion and the current way continues; inherited behaviour nobody
asked for is removed after a dated notice, and silence means it goes. A paid add-on may be suggested case by case but
never holds work. A hold by risk or QA names the client harm it prevents and the cost of the delay; a recommendation is
not a hold.

Nothing on client work waits on the owner except the four owner gates below and the takeover approval in `project.js`;
nothing paid is bought or turned on without the Money gate. A release through the client's usual flow is not go-live,
a new commitment or a public or irreversible move. A client's repo settings, accounts and paid plans fall under the client
rows above, not under credentials, accounts or billing. Where rows conflict on client work, the client rows win.

## The four owner gates

1. **Money**: new spend, a budget increase, a vendor or payment.
2. **Access**: credentials, accounts, permissions, production or client data.
3. **Ownership**: takeover scope, contracts, legal, who owns what.
4. **Commitment**: a promise to anyone outside the company, a public or irreversible move.

## Owner scope: what may go to the owner at all

The owner is a busy non-technical person. Only these reach them:

- money beyond the company's own limits;
- an account or identity in the owner's own name (a sign-up, a sign-in, a key only they can get);
- legal, ownership or commitment decisions;
- company direction and priorities;
- risk acceptance the governance level reserves for the owner (a category at `approve`);
- the fixed gates.

Everything else (infrastructure, monitoring, health checks, tooling, service registers, timers, framework bugs,
internal process) is the crew's: handle it yourself, hand it to the risk, tools or floor seat, or file a framework
request (`harness-change.js propose`). The ask composer (`company/tools/lib/owner-scope.js`, used by `inbox.js ask` and
`approvals.js ask`) refuses a crew-scope ask and says where it goes. An owner question must be two short plain
sentences that say what the owner gets or risks and what happens if they skip it (a sensible default), with every
technical word, number, id and path under `--details`; one that is not is returned with a plain rewrite. A topic the
owner answered "not now" is not asked again for 7 days unless something material changed (`--changed "<what>"`).
When an owner-scope ask needs an account only the owner can make (a free monitoring account, say), use the plain
template: "Could you create a free <service> account in your name and paste what it gives you here? It lets us <what
you get>; if you skip it, <what we do instead>."

## How an owner question is written

Asked through `node company/tools/inbox.js ask` (skill `owner-questions`). It shows on the owner's Today screen the moment
it is asked, so ask when the decision is ready, one decision per question, and retire a question you replace.
Several decisions at once go in ONE request with `--questions` (each answered on its own; a single Approve/Decline that
lists several decisions is refused). **Never ask the owner to run a command** (`patch -p1`, `node …`, `git …`, "in
your shell"): the ask is refused. A framework file is a framework request (`harness-change.js propose`); a locked
company tool is the same propose, which the owner approves on Today and harness-change applies; anything else is a
handoff to the tools seat. Details: skill `owner-questions`.

**Say it like a person.** `--message` is 2-4 conversational sentences: what you need, why, and what happens if the
owner says no. Evidence, numbers, ids, file paths and alternatives go in `--details`, which the console folds under
"More detail". `ask` warns when the message is missing, over 400 characters, or reads like a report.

- Good: `--message "Could you make a free Quotely account and paste its API key? It lets us test our main idea about
  commodity prices. If you say no, that idea waits and nothing else changes." --details "Quotely answers 401 without a
  key; 200 ms gold, 50 ms WTI; ..."`
- Bad: `--q "Access gate (gate 2), no payment, second key: a free Quotely API key. Quotely's discovery endpoint answers us
  anonymously (200 ms gold, 50 ms WTI) but the price stream is 401, so ..."` (a report, with the ask buried in it)

**Give the owner the right control.** A question is a form: pick a shortcut with `--kind`, or compose your own with
`--form` (fields: info, text, secret, choice, link, number, date, checkbox; and your own named actions such as
"Approve", "Not now", "Use the free tier instead", each mapping to a verdict).

- A key, token or password: `--kind secret --name <file>` (e.g. `tradex-api-key`). The owner pastes it into a password
  field; the console stores it as `secrets/<name>` (0600) and you get back only "stored at secrets/<name> (N chars,
  validated: yes/no)". **Never ask the owner to paste a key in a message or in chat**, and never ask for one in a text
  field (refused). Your tools read it with `co.secret('<name>')`, under the secrets guardrail; never print it.
- A sign-up or a page the owner must visit: `--kind link --url --action`; when you need non-secret details back (a
  username, the sign-in email): `--kind account --fields "id:Label,..."`.
- Options: `--kind choice --options "id:Label,..." --recommended <id>`. An open question: `--kind text`.
  A figure: `--kind number --unit`. A day: `--kind date`. A plain yes/no: the default (`approve`).

The owner may also Reply in their own words, Snooze ("snoozed until ..." shows in `inbox.js list`), or Discuss it in a
live chat with you. The answer comes back to you as an owner message naming the question id, in plain words.

## Self-governance

The table above says who inside the company decides. Self-governance says how much of that the owner lets the company
decide alone. The owner sets one level per category in `company/state/governance.json` (defaults in
`company/defaults/state/governance.json`); tools read it through `co.gate(category)` and act through
`company/tools/lib/governance.js`.

| Level | What happens |
|---|---|
| **auto** | The accountable seat decides, as in the table above. |
| **notify** | The seat decides and goes ahead; the owner gets one plain sentence on the owner channel (`company/owner/outbound.jsonl`). |
| **triage** | A decision model decides between notify and approve: governance builds the facts from records, never from the acting seat (reversible and one-off from the owner's per-category table, the amount from the request, known vendor and recipient from the external-gate allowlist, clearances, parties and ledger, the seat's record from competence), `company/decision-models/gate-triage` answers `proceed-notify` (goes ahead; the owner's sentence names the model, version and rule that let it through) or `escalate` (exactly as approve). In shadow mode, or if the model cannot run, it always escalates and records what it would have said. See `docs/DECISION-MODELS.md`. |
| **approve** | The seat proposes and waits. The tool files one owner question (recommendation, and what happens if nobody answers) and stops; the same command run again after the owner answers yes goes ahead. A no stops it. |

Categories and where they are enforced:

| Category | Covers | Enforced in |
|---|---|---|
| hiring | opening a role, picking the hire | `hire.js open`, `hire.js pick` (the hire follows at once), `hire.js hire` |
| release | releasing or replacing a crew member (and a candidate from a round that hired nobody) | `hire.js fire`, `hire.js release` |
| budget | the metered cap, per-agent shares, pacing numbers, a hand-started pacing emergency | `harness-change.js apply` (pacing-policy.json, dispatch-budget.json), `pacer.js emergency on` |
| spend | new spend inside the approved cap, a new paid tool | the seat's own judgement today (no tool spends) |
| models | which model a seat or routine runs | `hire.js remodel`, `harness-change.js apply` (kind model). Not here: routing modes, tier caps and starting a model trial are the owner's own at every level; the people function only drafts a trial (`routing.js`, docs/ROUTING.md) |
| tools | shared tools, house rules, other policy numbers | `harness-change.js apply` (kinds tool, house-rule, policy) |
| schedules | routine clocks, dispatcher tick, cadence — inside the owner's tempo bounds only (docs/TEMPO.md) | `harness-change.js apply` (kind schedule), `cadence.js set-default` / `set` |
| external | anything that leaves the company | `external-gate.js`: auto = the CEO's clearance suffices; notify = the CEO's clearance and the owner is told; approve = the clearance row must name the owner |
| dashboard | agents adding or changing console panels | the console panel tools (wired with the console) |
| org | the company's structure: creating a department, setting its lead, moving a seat between departments (docs/DEPARTMENTS.md) | `departments.js create`, `set-lead`, `add-member`, `remove-member`, `move`, `apply` (the CEO applies at this level; the people function only proposes; the owner always may) |
| packs | approving a capability pack (a new line of business); install is always the owner's | `pack.js approve` (approve = owner only; notify/auto = the CEO seat may approve, notify tells the owner); `pack.js install` is owner-only at every level. `approve` in every preset (docs/PACKS-SPEC.md) |

**Presets** (`node company/tools/governance.js preset <id> --by <owner>`):

- **Approve everything** (`approve-everything`): every category is approve.
- **Gate money and people** (`gate-money-people`, the default): hiring, release, budget, spend, external and org are approve; models, tools, schedules and dashboard are notify.
- **Gate money** (`gate-money`): budget and spend are approve; hiring, release, external and org are notify; the rest auto.
- **Autonomous** (`autonomous`): the company hires and budgets on its own; release is notify; everything else auto except packs.

Every preset keeps **packs** at approve: a new line of business is the owner's call. No preset uses **triage**: the
owner opts a category in (`governance.js set spend triage --by <owner>`), promotes the model to live
(`decide.js promote gate-triage 2 --mode live --by <owner>`), declares which categories are reversible and one-off
(`decide.js set-param gate-triage reversibleCategories tools,schedules --by <owner>`, likewise `oneOffCategories`;
both ship empty, so nothing passes) and, for spend, sets the threshold, which ships at 0 so no spend passes
(`decide.js set-param gate-triage maxSpendUsd 20 --by <owner>`). The model also escalates hiring, release, budget and
packs whatever the facts. A tool that has not been taught triage reads a triage category as approve. A fact the acting
seat asserts about itself never counts (docs/DECISION-MODELS.md, *Fact provenance*). Every proceed has a decisionId;
the owner replying "undo d-…", a refund or credit note naming it, or a breached commitment naming it marks it bad, and
one bad outcome sends the model back to shadow (`decide.js health`).

**Fixed gates.** Access, ownership, commitment, and spend beyond the cap are always approve, never triage. They are not categories,
`governance.js` refuses to change them, and they stay approve while the `ownerGates` guardrail is on
(`company/state/guardrails.json`).

**Who changes it.** Only the owner, from their own shell: `node company/tools/governance.js set <category>
<auto|notify|triage|approve> --by <owner>`. Promoting a decision model and setting its thresholds are the owner's too
(`decide.js promote|set-param --by <owner>`). Agents can read the levels (`show`, `check <category>`) and never change them.
Each change is a line in `company/work/decisions.md` and a row in `company/state/governance-log.jsonl`, and
`locked-watch.js` reports any edit to `governance.json` that `governance.js` did not make.

An unknown category, or a file that cannot be read, counts as approve: the dial fails closed.

## Delegation while the owner is away

The owner may name someone to answer their approve/triage questions for a while:

```
node company/tools/delegation.js grant --to Pat --categories spend,hiring --until 2026-11-30T18:00:00Z --by owner --why "away"
node company/tools/delegation.js revoke dg-001 --by owner
node company/tools/delegation.js list
node company/tools/delegation.js answer q-123456 --by Pat --a "yes, go ahead"     (the delegate)
```

While it is active, `lib/governance` treats the delegate's answer to a question in those categories as the owner's,
recorded as "delegate Pat for owner". Limits: only the owner grants or revokes, from their own shell; never to the
owner; never for the four fixed owner gates, packs, guardrails or governance itself; at most 14 days and it expires
hard; a delegate never answers a question they raised; an owner answer always wins. Every delegate answer is a row in
`company/state/delegations-log.jsonl`, a line in `company/work/decisions.md`, and one sentence to the owner.
`company/state/delegations.json` and its log are locked (`company/state/locked-extra.json`, source `delegation.js`).

## Decisions taken

Recorded in `company/work/decisions.md`, newest first, with who decided and why, only through
`node company/tools/decision.js add --by <you> --text "..." --why "..."`. The file is grow-only: an entry is never edited or
removed in place. A decision that changes is amended (`decision.js amend <id-or-stamp> --by <you> --why "..."`) and one
that no longer stands is withdrawn (`decision.js withdraw <id-or-stamp> --by <you> --why "..."`); both add a new entry
that names the earlier one.
