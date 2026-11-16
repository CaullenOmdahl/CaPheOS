# Chain of Command

**Ask up one level, not to the top.** The CEO is not a support desk. A question reaches the CEO only if a CEO would
be the one to answer it.

## The chain

```
Owner                               ← only the four gates: money, access, ownership, commitment
   │
CEO (the Founder)                   ← strategy, priorities, cross-function calls, opening roles, risk acceptance
   │
Function owners                     ← people · tools · risk · floor · finance, and domain leads as they are hired
   │
Specialists                         ← everyone else
```

Reporting lines are the `manager` field of each seat in `company/tools/loops.json`; functions are its `functions`
field. Until the company hires, the Founder holds every function and this chain is one level deep.

## Who answers what

| Question is about | Goes to |
|---|---|
| Tooling, routines, harness config, station service | the **tools** owner |
| Secrets, permissions, access, dependency or legal-exposure risk | the **risk** owner |
| Spend inside the budget, caps, AI usage, cost tradeoffs | the **finance** owner |
| Role definition, hiring, performance, model changes | the **people** owner (with the person's manager) |
| Floor plan, desks, rooms | the **floor** owner |
| The work of a domain (a case, a portfolio, a collection) | that domain's lead |
| Strategy, what to do next, money beyond the cap, opening a role, cross-function conflicts, risk acceptance, external commitments, ownership | the **CEO** |

`node company/tools/ask.js` routes a question by topic to the function holder and refuses to send a non-CEO question
to the CEO.

## The CEO test

Before asking the CEO: *"Would a CEO answer this?"* If not, it goes to the function owner. A CEO question arrives with
a recommendation and the options, never as an open question. A question that arrived below the CEO's level goes back
down to its owner with one line saying why.

## People matters

Performance, model changes, replacing someone and picking a hire are decided by the person's manager with the people
owner; by the people owner alone when the manager is the CEO. Recorded in `company/work/decisions.md`, where the CEO
can overrule.
