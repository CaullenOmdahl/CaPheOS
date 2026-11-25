# project-takeover

**What it does.** Access is not ownership. Read and assess a repository freely, but before modifying, rebranding, shipping, publishing or claiming any product, verify the owner approved the takeover in company/projects.json. Never self-approve.

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable project-takeover --by owner`. The skill leaves the company's list.
