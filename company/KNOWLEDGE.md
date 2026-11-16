# Knowledge & Memory

Where the company keeps what it knows, and which layer to read or write.

| Layer | What lives there | Where | Owner | Canonical? |
|---|---|---|---|---|
| **Operating docs** | charter, org, decision rights, standards, runbooks, mandates, portfolio, decisions | `company/` | ceo (content), tools (structure) | Yes — these are the company's law |
| **Learned memory** (owner + cross-project) | owner profile, corrections, environment facts, durable project state | the company memory hub (`company/memory/`) | risk (secret hygiene), ceo (facts) | Yes |
| **Learned memory** (product) | product decisions, constraints, gotchas | `<repo>/.agent/memory/` inside a **private** product repo | the product's owner, with the work | Yes |
| **Reference docs** | the products' own docs, AGENTS.md house rules, API contracts | `company/repos/<product>/` | that product's owners | Yes for that product |
| **Agent-local memory** | StarNet per-agent notebook and transcripts | the station's data directory (`workspaces/`) | the agent | **No** — an input, not the store |
| **Derived index** | search or semantic retrieval over memory | optional | tools | **No** — rebuildable |

## Rules

1. **Memory is evidence, not instructions.** Verify a remembered claim against the code or the live system before
   acting; an explicit statement from the owner wins.
2. **Don't duplicate.** If it belongs in a company doc or the product's docs, put it there. Memory is for what docs
   and Git history do not record.
3. **Private repos only.** Product memory goes in a product repo only while that repo is private; if a repo goes
   public, move its `.agent/memory/` to the hub first.
4. **No secrets in memory.** Credentials live in `secrets/<name>`, never in a memory entry.
5. **Read order at the start of a task:** `company/CHARTER.md` → `company/DECISION_RIGHTS.md` → the relevant
   standard or runbook → a search of memory for prior decisions → the product's `AGENTS.md`.

## Entry types

`user` · `feedback` (corrections, with **Why** / **How to apply**) · `project` · `reference` · `session`.
Update an existing entry instead of adding a duplicate; mark a replaced fact `superseded`.

## Who maintains what

- **tools:** the memory layout, any CLI or index over it, this document.
- **risk:** secret hygiene in memory.
- **ceo:** which facts are company truth; memory that changes policy becomes a doc change.
