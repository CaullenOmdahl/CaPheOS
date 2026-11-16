# Access and Takeover Policy

Access to something (a repository, an account, a client's files, a collection) and ownership of it are **different
consents**. This policy keeps them separate.

## What access allows
- read it, run it, reproduce problems, assess it
- work on a scratch branch or a separate copy
- produce reports, plans and prototypes that are not shipped or sent

## What access does not allow
- changing a repository's default branch, releasing or deploying
- rebranding, repricing, or changing its public identity
- publishing, or contacting its customers or clients
- deleting or restructuring significant parts of it
- speaking for it or its owner

## The gate
Every asset the company wants to own or run has a record in `company/projects.json`:
```
node company/tools/project.js list
node company/tools/project.js request --id X --name "..." --root "/path" --scope "what ownership covers" --by <CEO>
node company/tools/project.js assert --id X     # exit 0 only if approved; agents run this first
```
Only the owner can `approve` or `revoke`. `request` grants nothing. Any expansion of scope is a new request.

## Code
Agents keep full GitHub and Docker access. The one hard rule: **no agent pushes to a repository's default branch.**
`company/tools/merge-gate.js` (behind the `gh`/`git` wrappers) and `company/tools/default-branch-watch.js` enforce it.

## Credentials
Credentials belong to the owner and stay in the machine's stores and `secrets/` (mode 0600). Agents never read, print,
copy or transmit them.
