---
name: refusal-escalation
description: How to handle a model refusal, a limit, a capability wall, or a false refusal from our own tooling without stalling the company. Classify the block (T1-T5), log it, hand it off in the standard BLOCKED shape, and let the CEO reassign. Never reword a refused request to get around a safety decision, and never satisfy a check by hiding from it.
license: MIT
metadata:
  owner: company
  version: "1.2"
---

# Refusal & Limit Escalation

A refusal is information, not failure. Never argue with it, never hide it, never rewrite the same
request to extract a different answer from a safety layer. Classify it, log it, hand it off.

## 1. Classify

| Class | Symptoms | What you do |
|---|---|---|
| **T1 · Capacity** | 429 rate limit, quota exhausted, overloaded, timeout | retry with backoff or rotate credential; log it; carry on |
| **T2 · Capability** | context overflow, output cap, model not found, chat-template refusal | split the task smaller or ask the CEO to reassign it to another model |
| **T3 · Policy refusal** | the model declines the request itself (content policy, safety, "I can't help with that") | **STOP.** Log it verbatim. The CEO decides: reassign the legitimate adjacent work, or escalate to the owner |
| **T4 · Subscription limit** | the Claude plan's usage ceiling, a provider allowance spent | ask the CEO to shift the work to a seat on another provider (`company/MODEL_POLICY.md`) or a contractor (`company/tools/agy-contract.js`); same context, different family |
| **T5 · Mechanical refusal (tool defect)** | one of *our own* gates, watchers or scripts refuses you for something about the **shape of your command** or your own past reads, not the substance — e.g. a watcher that reads "you changed this file" out of any command text that merely named the path, so the only person allowed to accept the file is disqualified by having inspected it | **Do not route around it.** Name the predicate, ask for one ruling, leave the state honest (`flagged`, uncertified, step unticked). See §7 |

## 2. Log it

Run this once, with the real values:

```
node company/tools/escalate.js --agent <YOUR_NAME> --model <model-id> --class T1|T2|T3|T4 \
     --task "<one line: what you were doing>" --reason "<one line: the cause>" \
     --verbatim "<the exact refusal or error text>"
```

It appends to `company/escalations.jsonl` and prints the sanctioned next route. If you have no
workbench, write the same fields to your notebook instead and still report them.

## 3. Report in the standard shape

Reply exactly like this — nothing else, no apology, no hidden retries:

```
BLOCKED · T<n> · <model> · <one-line cause>
task: <what I was doing, one line>
exact: "<the verbatim refusal or error>"
tried: <what I attempted, one line>
need: <what would unblock this — another model family / a smaller scope / a human decision>
```

## 4. What the CEO does

- T1 → tells you to retry/rotate. Nothing else.
- T2 → re-dispatches with a smaller scope or to another specialist.
- T3 → does **not** re-send the same request. The CEO either places the legitimate adjacent work with a seat on another
  model family or a contractor and says so plainly, or escalates a decision to the owner. Escalation is a valid outcome.
- T4 → shifts the task to another family for the duration and notes it for finance.
- T5 → a tooling defect, so it goes to engineering (the tool's owner) or to whoever owns the predicate,
  never to the person whose check fired.

## 5. Not a refusal: the external clearance gate

`company/tools/external-gate.js` is a **control**, not a safety layer, and it is outside the T1–T5
taxonomy. A gate answer is never a reason to escalate or to reword anything — it is a reason to find out
whether a row already covers the act.

- A `check` that refuses the row you *just wrote in this same run* may be a **record lag**, not a real
  refusal: the row is written before the run's own record lands. Run `list` first and read the row's
  state before concluding anything.
- The only correct workarounds are: wait for the run to close and re-check, or ask the CEO for a
  correctly scoped row. **Never** set `EXTERNAL_GATE_SESSION`, hand-edit
  `company/state/external-clearances.jsonl`, or treat a row you cannot yet read as a refusal to route
  around. A gate that is working and a gate that has not yet recorded look identical from one command.
- Before acting on a row, read the row's **target and note** — not just its green answer. A target that
  names a repository or service does not necessarily name your branch or commit, so prove the row
  covers *your* act (and that it does not cover someone else's) rather than assuming a permissive answer
  means the act you intended is the act authorised.
- Ending a spent row is `close --id <row> --by <ceo> --why "…"` and is a CEO act; the row is recorded as
  closed, never deleted.
- **Read the `clearanceId` in the answer, not just `allow: true`.** With two live rows on one target,
  `check` returns the **first in ledger order**, and `--act` cannot break the tie unless a row carries an
  `acts[]` array. A spent row that matches first keeps winning for every later check on that target, while the row
  actually written for the act is never consulted. An allow naming the wrong row is worse than a
  refusal: acting on it writes an audit entry that reads like a violation of a comment-only clearance. If
  the returned id is not the row that authorises your act, **do not act** — report which row won, hand off
  the one-command fix (`close --id <spent-row> --by <ceo>`) and give the gate's owner the structural ask:
  fail closed when more than one row matches, with `acts[]` mandatory on every row. This is a control
  answering badly, not a policy limit: it does not go through `escalate.js`.

## 6. The hard rule

Never reword a T3 request to get around a refusal. Circumventing a safety decision corrupts the audit
trail and endangers the company. Solve a different, legitimate problem instead — and say which one.

## 7. T5: a false refusal from our own tooling

Not every refusal is a policy decision. A gate or watcher of ours can refuse you because it misreads
your *conduct* — and the handling is still "do not route around it".

- **Never satisfy a check by hiding from it.** Keeping the path out of your command line (a wrapper
  launcher, `$VAR` indirection, a rename, a nested shell) makes the check pass while proving nothing,
  and it publishes the evasion to the next reader. That is worse than the refusal it dodges.
- **Name the mechanism, not the symptom.** Cite the file and line plus the predicate that fired — for
  example, a watcher testing the raw command **text** for the path, so `wc -l`, `grep`, and even
  running the tool counted as editing the file. A fix needs the predicate; the complaint alone cannot
  be fixed.
- **Leave the honest state.** Flags stay `flagged`, the row stays uncertified, the quest step stays
  unticked. "Reviewed, evidence in hand, signature blocked by the check" is worth more than a signature
  obtained by laundering, and a green that came from an evasion is a lie in the audit trail.
- **One ruling, one owner.** Ask for the predicate to be fixed (engineering) or for the owner to accept
  a gate they have actually read. Do not ask the person whose check refused you to also waive it.
- **Retry only after the predicate changes.** A retry inside the same run usually re-triggers the same
  false positive, and the failed attempt itself often counts as another touch of the file.
- **Where it goes:** `escalate.js` accepts only T1–T4. Log a T5 in your work log or the improvements log
  with the quoted refusal and the line number; the escalation file is for model and policy limits.

T3 and T5 are opposites and both are strict: T3 is a safety limit you must not argue with, T5 is a
tooling defect you must report accurately. Neither is a licence to reword the request.
