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
| Security posture, secrets, access, legal exposure | **risk** | CEO | creating or rotating credentials, or accepting a high risk |
| Floor plan, desks, rooms | **floor** | tools, CEO | never |
| Role charters, hiring process, interview criteria | **people** | the role's manager | it adds recurring spend beyond the cap |
| Opening a role (headcount) | **CEO** | finance | it adds recurring cost beyond the cap |
| Picking a hire, performance, model changes, replacing someone | **manager + people** (people alone when the manager is the CEO) | finance | never; recorded in decisions.md |
| Spend inside the approved budget | **CEO + finance** | — | it exceeds the cap or starts a new vendor |
| Credentials, accounts, access, billing | — | risk proposes | **always** |
| Ownership, takeover scope, contracts, legal | — | CEO | **always** |
| Promises to clients, public announcements, go-live | — | CEO | **always** |
| Personal or private data beyond the task | — | risk | **always** |

## The four owner gates

1. **Money**: new spend, a budget increase, a vendor or payment.
2. **Access**: credentials, accounts, permissions, production or client data.
3. **Ownership**: takeover scope, contracts, legal, who owns what.
4. **Commitment**: a promise to anyone outside the company, a public or irreversible move.

## How an owner question is written

Asked through `node company/tools/inbox.js ask`. It shows on the owner's Today screen the moment it is asked, so ask when the
decision is ready, one decision per question, and retire a question you replace:

> **Decision needed:** X. **Why only you:** gate 2 (access). **Options:** A / B. **Recommendation:** A, because...
> **Default if silent:** we proceed with A on <date>.

## Self-governance

The table above says who inside the company decides. Self-governance says how much of that the owner lets the company
decide alone. The owner sets one level per category in `company/state/governance.json` (defaults in
`company/defaults/state/governance.json`); tools read it through `co.gate(category)` and act through
`company/tools/lib/governance.js`.

| Level | What happens |
|---|---|
| **auto** | The accountable seat decides, as in the table above. |
| **notify** | The seat decides and goes ahead; the owner gets one plain sentence on the owner channel (`company/owner/outbound.jsonl`). |
| **approve** | The seat proposes and waits. The tool files one owner question (recommendation, and what happens if nobody answers) and stops; the same command run again after the owner answers yes goes ahead. A no stops it. |

Categories and where they are enforced:

| Category | Covers | Enforced in |
|---|---|---|
| hiring | opening a role, picking the hire | `hire.js open`, `hire.js hire` |
| release | releasing or replacing a crew member (and a candidate from a round that hired nobody) | `hire.js fire`, `hire.js release` |
| budget | the metered cap, per-agent shares, pacing numbers, a hand-started pacing emergency | `harness-change.js apply` (pacing-policy.json, dispatch-budget.json), `pacer.js emergency on` |
| spend | new spend inside the approved cap, a new paid tool | the seat's own judgement today (no tool spends) |
| models | which model a seat or routine runs | `hire.js remodel`, `harness-change.js apply` (kind model) |
| tools | shared tools, house rules, other policy numbers | `harness-change.js apply` (kinds tool, house-rule, policy) |
| schedules | routine clocks, dispatcher tick, cadence | `harness-change.js apply` (kind schedule) |
| external | anything that leaves the company | `external-gate.js`: auto = the CEO's clearance suffices; notify = the CEO's clearance and the owner is told; approve = the clearance row must name the owner |
| dashboard | agents adding or changing console panels | the console panel tools (wired with the console) |
| packs | approving a capability pack (a new line of business); install is always the owner's | `pack.js approve` (approve = owner only; notify/auto = the CEO seat may approve, notify tells the owner); `pack.js install` is owner-only at every level. `approve` in every preset (docs/PACKS-SPEC.md) |

**Presets** (`node company/tools/governance.js preset <id> --by <owner>`):

- **Approve everything** (`approve-everything`): every category is approve.
- **Gate money and people** (`gate-money-people`, the default): hiring, release, budget, spend and external are approve; models, tools, schedules and dashboard are notify.
- **Gate money** (`gate-money`): budget and spend are approve; hiring, release and external are notify; the rest auto.
- **Autonomous** (`autonomous`): the company hires and budgets on its own; release is notify; everything else auto except packs.

Every preset keeps **packs** at approve: a new line of business is the owner's call.

**Fixed gates.** Access, ownership, commitment, and spend beyond the cap are always approve. They are not categories,
`governance.js` refuses to change them, and they stay approve while the `ownerGates` guardrail is on
(`company/state/guardrails.json`).

**Who changes it.** Only the owner, from their own shell: `node company/tools/governance.js set <category>
<auto|notify|approve> --by <owner>`. Agents can read the levels (`show`, `check <category>`) and never change them.
Each change is a line in `company/work/decisions.md` and a row in `company/state/governance-log.jsonl`, and
`locked-watch.js` reports any edit to `governance.json` that `governance.js` did not make.

An unknown category, or a file that cannot be read, counts as approve: the dial fails closed.

## Decisions taken

Recorded in `company/work/decisions.md`, newest first, with who decided and why.
