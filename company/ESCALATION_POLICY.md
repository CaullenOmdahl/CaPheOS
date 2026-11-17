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

**A refused run falls over to the next model (owner ruling; company/tools/lib/refusal.js).** A provider's filter can
refuse an ordinary run, for example one that printed a credential file. Wherever a run is refused (a routine or
dispatcher run, the owner's chat, a Sprint lane, an interview turn), that same run is retried ONCE, unchanged, on the
seat's next model (another provider first, e.g. DeepSeek), and the failover is recorded on the seat (Settings › Models
shows it). A retry is not a rewording: the prompt stays exactly as it was. If every model in the chain refuses, it is
reported plainly and stops; the work is never silently lost. For a routine, the pacer also blocks the refusing
provider for that routine: 2 hours after its first refusal, 24 hours after a second one within 24 hours, and a second
refusal is a T3 the CEO looks at. Nobody edits a prompt to get past a refusal.

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
