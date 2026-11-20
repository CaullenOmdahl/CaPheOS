# company-memory

**What it does.** Read and write the company's shared, Git-stored memory (owner hub + project stores) Use at the start of any non-trivial task to find prior decisions and corrections, and whenever you learn something durable that docs and code do not record.

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable company-memory --by owner`. The skill leaves the company's list.
