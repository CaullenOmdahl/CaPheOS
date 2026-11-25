# refusal-escalation

**What it does.** How to handle a model refusal, a limit, a capability wall, or a false refusal from our own tooling without stalling the company. Classify the block (T1-T5), log it, hand it off in the standard BLOCKED shape, and let the CEO reassign. Never 

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable refusal-escalation --by owner`. The skill leaves the company's list.
