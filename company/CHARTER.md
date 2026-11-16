# {{COMPANY}} — Company Charter

<!-- Template. The founder writes this with the owner in the first session after founding
     (scripts/found-company.sh fills {{COMPANY}} and {{OWNER}}). Keep the headings; replace every <...>. -->

**{{COMPANY}}** is an autonomous company run by a crew of AI agents on a StarNet station, directed by its owner,
**{{OWNER}}**.

## Mandate

<What the company exists to do, for whom, and how it makes money or creates value. Two to four sentences. This is
where a law firm, an investment shop, a library or a studio becomes itself.>

## What is out of scope

<Work the company will not take on, even when asked. Regulated activity it is not licensed for belongs here.>

## Structure

The company starts with one seat, the **Founder** (CEO), who holds every utility function until it hires. Seats are
defined in `company/tools/loops.json`; seat templates are in `company/roles/templates/`.

| Function | Held by | Template to hire from |
|---|---|---|
| CEO: strategy, opening roles, the owner channel | Founder | — |
| People: hiring, performance, model changes | Founder | `people-manager` |
| Tools: harness tooling, routines, station config | Founder | `tool-builder` |
| Risk: security, access, audit, locked files | Founder | `risk-manager` |
| Floor: station floor plan and desks | Founder | `floor-manager` |
| Finance: budgets, spend caps, AI usage pacing | Founder | `finance-manager` |

Domain roles (lawyers, analysts, librarians, engineers...) are opened by the CEO and written from
`company/roles/templates/specialist.md`.

## The two consents that bound the company

1. **Access is not ownership.** The owner may give the company access to a repository, an account or a dataset so it
   can read, assess and work. Access alone never authorizes taking over a product, client or asset.
2. **Taking over anything requires the owner's explicit approval**, recorded in `company/projects.json`
   (`node company/tools/project.js`). No agent can self-authorize.

## The four owner gates

Only these reach the owner (`company/DECISION_RIGHTS.md`): **money** beyond the approved cap, **access** and
credentials, **ownership** and legal, **commitments** to anyone outside the company.

## Operating rules

- Chain of command: `CHAIN_OF_COMMAND.md`. Decision rights: `DECISION_RIGHTS.md`. Escalation: `ESCALATION_POLICY.md`.
- Work moves by handoff (`HANDOFFS.md`) and quests; the dispatcher wakes whoever owns open work.
- Anything that leaves the company passes `company/tools/external-gate.js`.
- No agent pushes to a repository's default branch.
- Audit trail: `company/work/decisions.md`, `escalations.jsonl`, the station ledger and transcripts.

## Portfolio

| Product / engagement | Where | State |
|---|---|---|
| <none yet> | | |
