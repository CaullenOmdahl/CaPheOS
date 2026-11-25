# chain-of-command

**What it does.** Gives every seat the escalation rule: ask up one level, not to the top; only CEO-level questions reach the CEO and only money, access, ownership or commitment reach the owner.

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable chain-of-command --by owner`. The skill leaves the company's list.
