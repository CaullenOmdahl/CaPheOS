# web-pages

**What it does.** Gives every seat the design baseline for pages people outside the company will see: the
fundamentals, a pattern per kind of page, and the screenshot review that must pass before a page ships.

**What it needs.** Nothing: no network, no files outside its own folder, no secrets, no other unit.

**What it may touch.** Nothing. It only provides a skill through the `skills` service.

**How it runs.** `host/index.js` is a Cordis plugin (`apply`, `inject: ['skills']`). On the current stack the compat host
(`runtime/src/compat-host.mjs`) runs it and `company/tools/skills.js` pushes the skill to the seats; the new backend
loads the same plugin directly.

**How to remove it.** `node company/tools/unit.js disable web-pages --by owner`. The skill leaves the company's list.
