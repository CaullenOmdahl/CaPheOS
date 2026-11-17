# Escalation and Refusal Policy

A refusal is **information, not failure**: record it, hand it to someone who can, and never pretend it was handled.

## The four classes

| Class | What happened | Who handles it | Rule |
|---|---|---|---|
| **T1 · Capacity** | rate limit, quota, overload, timeout | the agent | retry with backoff; log it |
| **T2 · Capability** | context overflow, output cap, model missing | the agent, then the CEO | split the task, shrink scope, or reassign to another model |
| **T3 · Policy refusal** | the model declined the request itself | **the CEO** | STOP. Record the exact refusal. Reassign only a *legitimate* adjacent task, or take it to the owner |
| **T4 · Subscription limit** | a plan's usage ceiling is spent | **the CEO** | move the task to another model family for the duration; log it |

## The one hard rule

**Never reword a prompt to get around a T3 refusal.** That is circumvention, not escalation. A T3 stops the work on
that request. The company may solve a different, legitimate problem another way, and the CEO says exactly which.

**A refused scheduled run (the pacer, company/tools/pacer.js).** A provider's filter can refuse an ordinary routine
run, for example one that printed a credential file. A routine's FIRST refusal blocks that provider for that routine for
2 hours, and that one run is re-run once on the routine's next model, its prompt unchanged (a retry, not a rewording).
A SECOND refusal of the same routine within 24 hours is a T3: the provider is blocked for that routine for 24 hours,
nothing is re-run, and the CEO handles it as above. Nobody edits a routine's prompt to get past a refusal.

## How an agent reports a block

```
BLOCKED · T<n> · <model> · <one-line cause>
task: <what I was doing>
exact: "<the verbatim refusal or error>"
tried: <what I attempted>
need: <what would unblock this>
```

## Audit

Every block is appended to `company/escalations.jsonl` by `node company/tools/escalate.js`. The finance owner
reconciles the cost of any reroute; the risk owner watches for repeats (a task that keeps blocking is a process
defect, not an agent defect).
