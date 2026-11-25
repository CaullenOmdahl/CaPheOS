# console-panels

**What it does.** Add, change or remove a panel or a whole page (a dashboard screen of units, from a scaffold) on the owner console so it fits this company's work. Use when the owner keeps asking for the same numbers or list, or when your function produces d

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable console-panels --by owner`. The skill leaves the company's list.
