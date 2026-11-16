---
name: project-takeover
description: Access is not ownership. Read and assess a repository freely, but before modifying, rebranding, shipping, publishing or claiming any product, verify the owner approved the takeover in company/projects.json. Never self-approve.
license: MIT
metadata:
  owner: company
  version: "1.0"
---

# Product Takeover Gate

Repository access lets you **understand and work with** a product. It does **not** make the product
yours. Ownership needs the owner's explicit approval, recorded per project.

## Before you touch a product

```
node company/tools/project.js status --id <project-id>
```

- **`active` / `approved`** → you may work within the recorded scope. Cite the project id in your report.
- **anything else** → you may only assess, read, run locally, and prototype in a scratch copy. If the
  work the owner asked for would exceed that, file a request and stop:

```
node company/tools/project.js request --id <project-id> --name "<Product>" \
     --root "<repo path>" --scope "<exactly what ownership would cover>" --by <YOUR_NAME>
```

Then report: `AWAITING APPROVAL · <product> · takeover requested, scope: …`

## What counts as a takeover

Any of: changing the default/main branch or releasing, rebranding or renaming, changing public identity
or pricing, publishing/deploying, contacting its customers, deleting/restructuring significant parts,
or speaking for the product. Each needs an approved record.

## The hard rules

- **Never approve yourself.** Only `--by owner` may approve or revoke; the CLI refuses agent names.
- **Never edit `company/projects.json` by hand** — the CLI is the only writer; hand edits are a policy breach.
- **Scope does not stretch.** An approval covers the scope recorded with it; anything wider is a new request.
- **Credentials are the owner's.** Never read, print, copy or transmit `secrets/`, git credentials, SSH keys or
  tokens. If a push is needed, ask for a scoped approval; do not reach for the token.
- **Access ≠ ownership in your language too.** Say "the repository we have access to", not "our product",
  until the takeover is approved.

## When approved

Record the id in your work notes, respect the scope, and tell the owner before any irreversible or
outward-facing step (release, rebrand, publish, customer contact). A revoked project returns to
read-only immediately.
