# Plain language, everywhere

The rule behind every other rule here:

> If a person has to be taught what something means, the name is wrong.

The same philosophy as "if the UI needs explaining, it's bad UI" applies to code, comments, errors and docs. A new
person — or a model with no history — should read a file once and know what it does, what it needs, and what it
refuses.

---

## Naming

- **Say what it does, not what it resembles.** `task`, not `quest`. `owner`, not `commander`. `backend`, not `station`.
  `workspace`, not `desk`.
- **No metaphors, no codenames, no borrowed product names.** A word that only makes sense inside another product does
  not go in our code.
- **One noun per thing.** `task` means task in every file, route, table and error message. If two words exist for one
  concept, one is deleted.
- **Full words, not nicknames.** `configuration` may be `config` because everyone knows it; `usr` and `mgr` are banned.
  Industry words are fine (`api`, `url`, `id`, `json`).
- **Functions are sentence fragments.** `closeTaskOnEvidence`, `wakeOwner`, `readNewestSnapshot`. A function that needs
  a comment to explain its name has the wrong name.
- **Variables say what they hold.** `openTasks`, not `list`. `ownerQuestion`, not `item`.
- **Booleans read as a question.** `isHalted`, `hasEvidence`, `canSpend`.
- **Paths and routes read as sentences.** `/api/tasks/:id/close`, not `/api/q/close`.

## Comments

- Every file opens with a short header: what it is for (2–4 sentences), how to run it, and what it refuses.
- Comment the **why**, never the **what**. The code already says what it does.
- No history, no names, no dates, no inside jokes. If the reason is a past incident, write the rule it produced.
- Every exported function gets one line saying what it returns.
- Every non-obvious block gets one line saying what assumption it depends on.
- Prefer a longer clear comment to a clever short one.

## Errors and logs

- Plain words, sentence case, no jargon and no metaphors.
- Say **what happened** and **what to do next**: `no console token: put it in secrets/console-token`.
- Never show a codename or a game word in a message the owner can see.
- A refusal explains the gate, not just the failure: `refused: the owner has not approved this install`.
- Logs name the thing that happened, not the function that did it.

## Structure

- **One job per file**, and the file name is the job.
- **Dependencies point one way.** `server → runtime → services → files`. Nothing calls back up.
- **The smallest correct interface.** A service exposes what callers need, not what it knows.
- **No hidden coupling.** If two modules share state, that state has a name, an owner and one writer.
- If a module needs a README to be understood, it is too big — split it.

## Documents and UI copy

- Write for someone who started today: what this is, why it exists, what to do with it.
- UI copy follows the same rule: label the **outcome**, not the mechanism. "Approve the invoice", not "Resolve gate
  object".
- No internal shorthand in owner-facing text. If the owner would ask "what does that mean?", rewrite it.

## The vocabulary

The rename is part of the work, not cosmetics:

| Old | New |
|---|---|
| station, StarNet | **backend** |
| commander | **owner** |
| quest | **task** |
| quest step | **step** |
| quest artifact / contract | **evidence** |
| floor, desk | **workspace** (or deleted) |
| XP, levels | **competence** |
| roster | **seats** |
| save | **seat config** |
| cron, routine | **schedule** |

`level` survives only where it means governance (`approve` / `triage`). A lint over `company/`, `console/`, `runtime/`
and the routes keeps the old words out, with an explicit allow-list for anything genuinely business.

## Reviews

A change is ready when a person who did not write it can answer, without opening another file:

1. What does this do?
2. What does it need?
3. What does it refuse?
4. What happens if it fails?

If any answer is "read the other file", the change is not ready.
