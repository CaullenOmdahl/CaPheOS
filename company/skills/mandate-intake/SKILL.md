---
name: mandate-intake
description: How the company absorbs an operating mandate. A mandate is not a chat message — record it, assign owners, convert it into procedure, adopt it, review it. The company may self-issue mandates inside its authority; anything expanding permissions, ownership or spend needs the owner.
license: MIT
metadata:
  owner: company
  version: "1.1"
---

# Mandate Intake

A **mandate** is an instruction that changes how the company operates. It is first-class data, not a
message that scrolls away. The company is expected to absorb mandates **itself** as it matures; the
operator does not write our policy for us.

## The intake loop

1. **Record** — `node company/tools/mandate.js issue --id <id> --title "…" --text "…" --by owner`
   (or `--type self-improvement --by <agent>` for a mandate the company issues itself inside its authority).
2. **Assign** — The CEO breaks it into parts and names owners:
   `node company/tools/mandate.js assign --id <id> --agent <Name> --task "…"`
3. **Convert** — each owner turns its part into procedure: a document under `company/standards/`, a
   skill, a CLI tool, or a registry entry. Cite the mandate id in what you write.
4. **Adopt** — `node company/tools/mandate.js adopt --id <id> --doc <path> --by <Name> --summary "…"`
   The register stamps a 30-day review; the company reviews and amends on schedule.
5. **Use it** — the standard is now operating procedure. Reference it in work reports.

## Authority rule

- **Owner mandates** (`--by owner`) may change anything, including permissions, ownership and spend.
- **Self-improvement mandates** (`--type self-improvement`) are allowed **only inside existing authority**:
  better process, tighter tests, clearer reporting, new internal tooling. They may not expand what the
  company is allowed to do, what it owns, or what it spends.
- If a self-improvement would cross one of those lines, **stop and ask the owner** via `company/tools/inbox.js`.

## Adding a role or a tool

Hiring for a new capability (e.g. IT tooling to interface with systems outside the harness) is a
normal mandate outcome:
- the mandate names the gap and the owner;
- the CEO defines the role or the tool's interface;
- people hires against the definition if a new agent is needed;
- risk reviews anything touching credentials, external accounts or deployment paths;
- finance prices recurring cost (subscriptions, API calls) before it is adopted.

## What "adopted" means

A mandate is adopted when its procedure exists in a file an agent can read and follow **without you in
the room**. If it only lives in a conversation, it is not adopted.

## From self-improvement to skill

A self-improvement often lands as a skill proposal rather than a document. The queue has its own gate, and
it reviews scope and load before it reviews prose.

- **Pre-screen on scope, size and spend.** A proposal that forks the company package for one agent, adds
  external access or a commitment, or has the agent pay for model frames is refused before anyone pays for
  an evaluation. Check character count and entry count first: length is a load cost, and a proposal that
  has to be loaded on every unrelated task is a cost even when its content is good.
- **Behaviour before opinion.** The proposal is evaluated on a task suite. A failed or regressed
  evaluation is refused whatever the content is worth; a tie is accepted only with `--accept-tie` and a
  written role-fit reason. A written `--why` on both approve and reject is the only durable record of the
  call.
- **Keep the text of a refusal.** Rejecting deletes the proposal, so save its sections somewhere durable
  first. Then tell the author in their own handoff file what to resubmit and in what form — usually the
  same rules, shorter, with the session recital cut.
