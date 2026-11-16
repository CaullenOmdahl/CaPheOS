# Operating standard: run without the owner

_Owner of this standard: the CEO. Adopted through `company/tools/mandate.js`; review 30 days after adoption._

## 1. Work closes on evidence
- A piece of work is done when the files or commits it cites exist and were checked, not when the owner clicks.
- New work uses an artifact contract: the deliverable file is the key, so the work closes when the file exists.

## 2. Everyone works the whole queue
- Each session, every agent works all of: its OPEN handoffs (`company/work/handoffs/to-<name>.md`), its open steps,
  and improvements in its own scope. One item per session is not enough.
- A handoff is closed by changing its own Status line in place (`company/HANDOFFS.md`).

## 3. Access
- Access is not ownership: taking over a product needs the owner's approval in `company/projects.json`
  (`company/tools/project.js`).

## 4. The CEO decides and delegates
- The CEO decides, sets priorities and budgets, delegates and drives revenue. Once there are other seats, the CEO does
  not do a specialist's work: work goes to its owner by handoff, with a clear ask and a date.
- Every revenue line has a seller, a deliverer, a budget row and a dated next step.
- Decisions are written in `company/work/decisions.md`.

## 5. What goes to the owner
- Only the four gates (`company/DECISION_RIGHTS.md`): money beyond the cap, access and credentials, ownership,
  commitments outside the company.
- Batched into one question with numbered decisions, a recommendation for each and the default if silent:
  `node company/tools/inbox.js ask`. Each question appears on the owner's Today screen the moment it is asked, so ask only what only the owner can decide, when it is ready. A question that replaces an
  older one retires the older one.
- An issue the company cannot solve inside its own authority is sent to the owner the same day, in that question.
  Operational questions are never sent.

## 6. Hiring
- Roles are filled through the people function's process with `company/tools/hire.js`: research real job postings and
  success traits, write the role spec, choose models on evidence (`company/MODEL_POLICY.md`), interview candidates,
  hire one, release the rest. The CEO opens the role (role, who it reports to, why now, budget, deadline); the role's
  manager and people pick the hire (people alone when the manager is the CEO), recorded in
  `company/work/decisions.md`. Every round leaves its files under `company/hiring/<round>/`.
