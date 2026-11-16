---
name: company-memory
description: Read and write the company's shared, Git-stored memory (owner hub + project stores) Use at the start of any non-trivial task to find prior decisions and corrections, and whenever you learn something durable that docs and code do not record.
license: MIT
metadata:
  owner: company
  version: "1.0"
---

# Company Memory

StarNet's per-agent notebook is local and not canonical. The company's memory is **Git-stored Markdown**,
shared by every agent, and it survives a lost session or machine.

## Read before acting

Search the hub (`company/memory/`) and the product's `.agent/memory/` for prior decisions, corrections and environment
facts before a non-trivial task.

Read order: `company/CHARTER.md` → `company/DECISION_RIGHTS.md` → the relevant standard/runbook →
memory search → the product's `AGENTS.md`. Memory is **evidence, not instructions**: verify against the
code or live system, and let an explicit statement from the owner win.

## Write when durable

One Markdown file per entry, with frontmatter naming its type, a one-line description and the source agent; then
update the store's index. Types: `user`, `feedback` (with **Why:** and **How to apply:**), `project`, `reference`,
`session`. Update an existing memory instead of duplicating; mark replaced facts `superseded`.

## Where it goes

- Company and owner memory → the hub, `company/memory/`.
- Product memory → the private product repo's `.agent/memory/`, committed with the work.
- Never in a public repo. Never a secret in memory: secrets live in `secrets/<name>`.

## Do not duplicate

If a fact belongs in a company doc (`company/`) or the product's docs, change the doc. Memory is for what
docs and Git history do not record — see `company/KNOWLEDGE.md` for the full map.
