# mandate-intake

**What it does.** How the company absorbs an operating mandate. A mandate is not a chat message — record it, assign owners, convert it into procedure, adopt it, review it. The company may self-issue mandates inside its authority; anything expanding permissio

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable mandate-intake --by owner`. The skill leaves the company's list.
