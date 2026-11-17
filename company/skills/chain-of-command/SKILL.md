---
name: chain-of-command
description: Ask up one level, not to the top. Use before addressing the CEO or the owner — route the question to the function owner who actually decides it. Only CEO-level questions reach the CEO; only money, access, ownership or commitment reach the owner.
license: MIT
metadata:
  owner: company
  version: "1.2"
---

# Chain of Command

The CEO is not a support desk. Before you ask the CEO anything, pass the **CEO test**: *would a CEO
answer this?* If a specialist or a function owner would, it goes down the chain, not up.

## Route it

```bash
node company/tools/ask.js --from <YOU> --topic <topic> --q "<question>" [--blocking]
node company/tools/ask.js owners          # who holds which function now
```

| Topic | Function |
|---|---|
| engineering, tooling, harness, skills | tools |
| security, secrets, access hygiene | risk |
| finance inside budget, pacing, spend | finance |
| hiring, roles, performance, model changes | people |
| floor, desks, rooms | floor |
| a domain's own work (design, product, deploy, research, ...) | that domain's lead |
| strategy, priorities, cross-function, external | ceo |

At founding the Founder holds every function, so most questions land on one seat; route by function anyway, so the
chain still works once seats are hired.

## Rules

1. **One level at a time.** Escalate to the next level with evidence and a recommendation; never skip.
2. **Never address the CEO with a non-CEO question.** `ask.js` refuses it — and the CEO will send it back down
   with one line saying why.
3. **A CEO question carries options.** The CEO answers with a decision; "what should we do?" without a
   recommendation is not a CEO question, it is a delegation of your job.
4. **Owner gates** are only money, access, ownership, commitment — raised by the function owner or the CEO,
   not by a specialist, and via `company/tools/inbox.js`. How to write one — plain words first, a secure field for
   keys, a link for sign-ups — is the `owner-questions` skill.
5. **Record** anything decided in `company/work/decisions.md`; the chain is only real if decisions leave a trace.

## Procedure and skill proposals

A proposal to change how we work routes like any other question: to the owner who decides it, not to
whoever happens to be holding the queue.

- **The company package is not forked for one agent.** A proposal that changes shared tooling or a
  company-package skill on behalf of a single agent is outside that agent's authority — refuse it in the
  per-agent queue, name the package owner in the written reason, and let the change land once through
  `skills.js` rather than diverging per agent.
- **Your own seat is not yours to approve.** A proposal that would govern your own job goes up, not
  through: leave it pending and put it in front of whoever approves your role. Reviewing your own
  procedure is the one gate you cannot hold.
- **No proposal may widen what we are allowed to do, own or spend.** New external access, a new
  commitment, or a step that shifts model cost onto the agent is refused at triage and answered with the
  mandate route (`mandate-intake`) — not with an approval and a note.
